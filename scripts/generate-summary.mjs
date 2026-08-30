#!/usr/bin/env node
/**
 * AI BASE Discord Monthly Summary Generator
 *
 * Fetches Discord channel messages, categorizes them (normally by whichever
 * coding-agent session — Claude Code, Codex, etc. — is driving this script;
 * optionally via the Anthropic API), generates a full HTML summary page, and
 * creates a GitHub PR. See the two-phase `fetch` / `render` flow below.
 *
 * Usage:
 *   node scripts/generate-summary.mjs <channel_id> <channel_name>
 *   node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN  - Discord Bot token (required)
 *   ANTHROPIC_API_KEY  - Anthropic API key (optional — only needed for a
 *                        fully automated run with no live agent session;
 *                        the default path classifies via the driving session
 *                        itself, at no extra API cost)
 *
 * Example:
 *   DISCORD_BOT_TOKEN=xxx node scripts/generate-summary.mjs 1489234567890 朝活_202604
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Config ──────────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_API   = 'https://discord.com/api/v10';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-6';

const CATEGORY_NAMES = {
  openai:        'OpenAI／ChatGPT関連',
  agent:         'AIエージェント／自動化',
  tool:          'ツール・ライブラリ',
  repository:    'リポジトリ・サンプルコード',
  article:       'AI技術記事・解説',
  documentation: '公式ドキュメント・技術仕様',
  tutorial:      'チュートリアル・学習リソース',
  video:         '動画コンテンツ',
  other:         'その他',
};
const CATEGORY_ORDER = [
  'openai', 'tool', 'repository', 'agent',
  'article', 'documentation', 'tutorial', 'video', 'other',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function toJST(isoString) {
  const d = new Date(new Date(isoString).getTime() + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function extractUrl(content) {
  const m = content.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[.,)>]+$/, '') : null;
}

function extractComment(content) {
  const comment = content.replace(/https?:\/\/\S+/g, '').trim();
  return comment.length > 0 ? comment : null;
}

function isXUrl(url) {
  return /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(url);
}

// Discord escapes markdown-significant characters in embed text (e.g. "\.", "\*").
// Undo that so previews read like the original post.
function unescapeMarkdown(str) {
  return str.replace(/\\([_*~`.[\]()>#+\-!])/g, '$1');
}

// Embed author name looks like "表示名 (@handle)" — reformat to "@handle（表示名）"
// to match the site's convention for crediting the original poster.
function formatXAuthor(name, url) {
  if (!name) return null;
  let handle = null;
  if (url) {
    const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
    if (m) handle = m[1];
  }
  const handleMatch = name.match(/\(@([^)]+)\)\s*$/);
  if (!handle && handleMatch) handle = handleMatch[1];
  const displayName = name.replace(/\s*\(@[^)]+\)\s*$/, '').trim() || name;
  if (!handle) return escapeHtml(displayName);
  return `@${escapeHtml(handle)}（${escapeHtml(displayName)}）`;
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', ...opts }).trim();
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function fetchMessages(channelId) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_BOT_TOKEN is not set');

  const headers = { Authorization: `Bot ${DISCORD_TOKEN}` };
  const messages = [];
  let before = null;

  console.log('Fetching Discord messages...');
  while (true) {
    const url = `${DISCORD_API}/channels/${channelId}/messages?limit=100` +
                (before ? `&before=${before}` : '');
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord API error ${res.status}: ${err}`);
    }

    const batch = await res.json();
    if (batch.length === 0) break;
    messages.push(...batch);
    before = batch[batch.length - 1].id;

    if (batch.length < 100) break;
    await new Promise(r => setTimeout(r, 500)); // rate limit buffer
  }

  console.log(`  Fetched ${messages.length} messages`);
  return messages;
}

// ── Processing ────────────────────────────────────────────────────────────────

function processMessages(messages) {
  const seen = new Set();
  const result = [];

  for (const msg of messages) {
    const url = extractUrl(msg.content ?? '');
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const author = msg.author?.global_name || msg.author?.username || '不明';
    const comment = extractComment(msg.content);
    const date = toJST(msg.timestamp);
    const embedTitle      = msg.embeds?.[0]?.title ?? null;
    const embedDesc       = msg.embeds?.[0]?.description ? unescapeMarkdown(msg.embeds[0].description) : null;
    const embedAuthorName = msg.embeds?.[0]?.author?.name ?? null;
    const embedAuthorUrl  = msg.embeds?.[0]?.author?.url ?? null;

    result.push({ id: msg.id, url, comment, author, date, embedTitle, embedDesc, embedAuthorName, embedAuthorUrl });
  }

  console.log(`  ${result.length} messages with URLs (after dedup)`);
  return result;
}

// ── Categorization ───────────────────────────────────────────────────────────
//
// Classification (category / headline / tags per message) is normally done by
// whichever coding-agent session is driving this script (Claude Code, Codex,
// etc.) — no API call, no extra cost, uses that session's own model/subscription
// directly. categorizeMessages() below (Anthropic API, needs ANTHROPIC_API_KEY)
// is kept only as an optional path for headless/CI runs with no live agent
// session attached. CLASSIFICATION_RULES is the single source of truth for the
// category/tag vocabulary, shared by both paths.

const CLASSIFICATION_RULES = `カテゴリキー（いずれか1つ）:
openai / agent / tool / repository / article / documentation / tutorial / video / other

使用できるタグ（1〜3個）:
#Anthropic #OpenAI #Claude #ClaudeCode #Google #Gemma #モデル
#エージェント #ツール #セキュリティ #解説 #産業 #規約 #MCP
#リポジトリ #ドキュメント #チュートリアル #動画 #Tips #統計 #その他

注意:
- headlineは投稿者のコメントを踏まえて、シェアされたコンテンツの内容を要約すること
- タグはURLのドメインや内容から判断すること（例: anthropic.com → #Anthropic）`;

const CLASSIFICATION_ITEM_SHAPE = {
  id: '<元のメッセージID>',
  category: '<カテゴリキー>',
  headline: '<内容を一行で要約した日本語>',
  tags: ['#タグ1', '#タグ2'],
};

const SYSTEM_PROMPT = `あなたはAIコミュニティ（AI BASE）のDiscordメッセージを分類する専門家です。
以下のメッセージリストを一括で分析し、JSON配列で返してください。

各アイテムの形式:
${JSON.stringify(CLASSIFICATION_ITEM_SHAPE, null, 2)}

${CLASSIFICATION_RULES}
- JSONのみ返すこと（説明文不要）`;

// Optional: fully-automated classification via the Anthropic API. Only used
// when ANTHROPIC_API_KEY is set (e.g. headless/CI runs with no live
// coding-agent session driving the process).
async function categorizeMessages(messages) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  // Batch in chunks of 20 to stay within context limits
  const CHUNK = 20;
  const results = [];

  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    console.log(`  Categorizing messages ${i + 1}–${Math.min(i + CHUNK, messages.length)}...`);

    const userContent = JSON.stringify(
      chunk.map(m => ({
        id: m.id,
        url: m.url,
        comment: m.comment,
        embedTitle: m.embedTitle,
        embedDesc: m.embedDesc ? m.embedDesc.slice(0, 200) : null,
      })),
      null, 2
    );

    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text = data.content[0].text.trim();

    // Extract JSON array from response (may be wrapped in code block)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`Unexpected Anthropic API response: ${text.slice(0, 200)}`);

    const classified = JSON.parse(jsonMatch[0]);
    results.push(...classified);

    if (i + CHUNK < messages.length) {
      await new Promise(r => setTimeout(r, 1000)); // rate limit buffer
    }
  }

  return results;
}

// ── HTML generation ───────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateHTML(entries, channelName, yearMonth) {
  // Merge categorization with original data
  const byId = Object.fromEntries(entries.map(e => [e.id, e]));

  // Group by category → author
  const grouped = {};
  for (const entry of entries) {
    const cat = entry.category || 'other';
    if (!grouped[cat]) grouped[cat] = {};
    if (!grouped[cat][entry.author]) grouped[cat][entry.author] = [];
    grouped[cat][entry.author].push(entry);
  }

  // Build sections in fixed order
  let sections = '';
  let catIndex = 1;
  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat]) continue;
    const catName = CATEGORY_NAMES[cat] || cat;

    let contributors = '';
    for (const [author, items] of Object.entries(grouped[cat])) {
      let lis = '';
      for (const item of items) {
        const tags = (item.tags || [])
          .map(t => `<span class="tag">${escapeHtml(t)}</span>`)
          .join('\n                  ');
        const comment = item.comment
          ? `\n                <div class="entry-comment">${escapeHtml(item.comment)}</div>`
          : '';

        const isX = isXUrl(item.url);
        const xAuthor = isX ? formatXAuthor(item.embedAuthorName, item.embedAuthorUrl) : null;
        const xMeta = xAuthor
          ? `\n                <div class="x-meta"><span class="x-author">${xAuthor}</span></div>`
          : '';
        const xPreview = (isX && item.embedDesc)
          ? `\n                <details class="x-preview"><summary>ポスト本文</summary><p>${escapeHtml(item.embedDesc)}</p></details>`
          : '';

        lis += `
              <li>
                <span class="entry-date">${escapeHtml(item.date)}</span>
                <strong>${escapeHtml(item.headline)}</strong><br />
                <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a>${xMeta}${xPreview}
                <div class="entry-tags">
                  ${tags}
                </div>${comment}
              </li>`;
      }

      contributors += `
          <div class="contributor">
            <h3>投稿者：${escapeHtml(author)}</h3>
            <ul>${lis}
            </ul>
          </div>`;
    }

    sections += `
        <section class="category">
          <h2>${catIndex}. ${escapeHtml(catName)}</h2>
${contributors}
        </section>`;
    catIndex++;
  }

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI BASE - ${escapeHtml(yearMonth)}まとめ</title>
    <link rel="stylesheet" href="../style.css" />
    <style>
      .entry-date {
        display: block;
        font-size: 0.78rem;
        color: #999;
        margin-bottom: 0.3rem;
        font-variant-numeric: tabular-nums;
      }
      .entry-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-top: 0.5rem;
      }
      .tag {
        display: inline-block;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 600;
        background-color: #fde8ed;
        color: #c0504d;
        white-space: nowrap;
      }
      #view-tabs {
        display: flex;
        gap: 0.4rem;
        margin: 1.2rem 0 0;
      }
      .tab-btn {
        padding: 0.4rem 1.1rem;
        border-radius: 6px 6px 0 0;
        border: 1.5px solid #ddd;
        border-bottom: 0;
        background: #f7f7f7;
        color: #888;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
      }
      .tab-btn.active { background: #fff; color: #e85876; position: relative; bottom: -1px; z-index: 1; }
      #tag-filter {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0 0 2rem;
        padding: 0.8rem 0.6rem;
        border: 1.5px solid #ddd;
        border-radius: 0 6px 6px 6px;
      }
      .filter-btn {
        padding: 0.3rem 0.8rem;
        border-radius: 999px;
        border: 1.5px solid #ddd;
        background: #fff;
        color: #555;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .filter-btn:hover { border-color: #e85876; color: #e85876; }
      .filter-btn.active { background: #e85876; border-color: #e85876; color: #fff; }
      .hidden { display: none !important; }
      .entry-comment {
        font-size: 0.85rem;
        color: #666;
        margin: 0.6rem 0 0.2rem;
        padding: 0.4rem 0.75rem;
        border-left: 3px solid #e85876;
        background: #fdf5f7;
        border-radius: 0 4px 4px 0;
        white-space: pre-line;
        line-height: 1.6;
      }
      .x-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.3rem 0.8rem;
        margin-top: 0.35rem;
      }
      .x-author { font-size: 0.78rem; color: #888; }
      .x-preview { margin-top: 0.4rem; font-size: 0.85rem; }
      .x-preview summary { cursor: pointer; color: #e85876; font-size: 0.78rem; font-weight: 600; }
      .x-preview p {
        margin: 0.4rem 0 0;
        padding: 0.5rem 0.75rem;
        background: #f8f8f8;
        border-radius: 4px;
        color: #555;
        white-space: pre-line;
        line-height: 1.6;
      }
      #timeline-view { display: block; }
      .timeline-entry { padding: 0.75rem 0; border-bottom: 1px solid #f0f0f0; }
      .timeline-meta { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.3rem; flex-wrap: wrap; }
      .timeline-contributor { font-size: 0.78rem; font-weight: 600; color: #e85876; }
      .timeline-category { font-size: 0.72rem; color: #aaa; }
    </style>
  </head>
  <body>
    <header>
      <div class="logo-container">
        <img src="../img/yamanashi-aibase.png" alt="AI BASE Logo" class="logo" />
      </div>
      <h1>AI BASE</h1>
      <p class="tagline"><a href="../index.html">← Back to Home</a></p>
    </header>

    <main>
      <article class="summary">
        <h1>${escapeHtml(yearMonth)}まとめ - #${escapeHtml(channelName)}</h1>

        <div id="view-tabs">
          <button class="tab-btn" data-view="category">カテゴリ別</button>
          <button class="tab-btn active" data-view="timeline">時系列</button>
        </div>
        <div id="tag-filter"></div>
        <div id="category-view" style="display:none">
${sections}
        </div>
        <div id="timeline-view"></div>
      </article>
    </main>

    <footer>
      <p>&copy; ${new Date().getFullYear()} AI BASE. All rights reserved.</p>
    </footer>

    <script>
      (function () {
        let currentView = 'timeline';
        let currentTag = '';

        const tagSet = new Set();
        document.querySelectorAll('.entry-tags .tag').forEach(el => tagSet.add(el.textContent.trim()));

        const bar = document.getElementById('tag-filter');
        const makeBtn = (label, value) => {
          const btn = document.createElement('button');
          btn.className = 'filter-btn' + (value === '' ? ' active' : '');
          btn.textContent = label;
          btn.dataset.tag = value;
          bar.appendChild(btn);
        };
        makeBtn('すべて', '');
        tagSet.forEach(t => makeBtn(t, t));

        // Build the timeline view by flattening category → contributor → entries
        // (read straight out of the category view's DOM, then sorted by date).
        const timeline = document.getElementById('timeline-view');
        const items = [];
        document.querySelectorAll('#category-view .category').forEach(section => {
          const category = section.querySelector('h2').textContent.replace(/^\\d+\\.\\s*/, '');
          section.querySelectorAll('.contributor').forEach(contributor => {
            const user = contributor.querySelector('h3').textContent.replace('投稿者：', '');
            contributor.querySelectorAll('li').forEach(li => {
              const date = li.querySelector('.entry-date')?.textContent.trim() || '';
              const tags = Array.from(li.querySelectorAll('.tag')).map(t => t.textContent.trim());
              items.push({ category, user, date, tags, li });
            });
          });
        });
        items.sort((a, b) => a.date.localeCompare(b.date));
        items.forEach(({ category, user, date, tags, li }) => {
          const entry = document.createElement('div');
          entry.className = 'timeline-entry';
          entry.dataset.tags = JSON.stringify(tags);
          entry.innerHTML = '<div class="timeline-meta"><span class="entry-date" style="display:inline">' +
            date + '</span><span class="timeline-contributor"></span><span class="timeline-category"></span></div>';
          entry.querySelector('.timeline-contributor').textContent = user;
          entry.querySelector('.timeline-category').textContent = category;
          const clone = li.cloneNode(true);
          clone.querySelector('.entry-date')?.remove();
          entry.insertAdjacentHTML('beforeend', clone.innerHTML);
          timeline.appendChild(entry);
        });

        const applyFilter = () => {
          const all = currentTag === '';
          if (currentView === 'timeline') {
            document.querySelectorAll('.timeline-entry').forEach(entry => {
              entry.classList.toggle('hidden', !all && !JSON.parse(entry.dataset.tags).includes(currentTag));
            });
            return;
          }
          document.querySelectorAll('#category-view li').forEach(li => {
            const liTags = Array.from(li.querySelectorAll('.tag')).map(t => t.textContent.trim());
            li.classList.toggle('hidden', !all && !liTags.includes(currentTag));
          });
          document.querySelectorAll('.contributor').forEach(div => {
            div.classList.toggle('hidden', !div.querySelector('li:not(.hidden)'));
          });
          document.querySelectorAll('.category').forEach(sec => {
            sec.classList.toggle('hidden', !sec.querySelector('li:not(.hidden)'));
          });
        };

        document.getElementById('view-tabs').addEventListener('click', e => {
          const btn = e.target.closest('.tab-btn');
          if (!btn) return;
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentView = btn.dataset.view;
          document.getElementById('category-view').style.display = currentView === 'category' ? 'block' : 'none';
          timeline.style.display = currentView === 'timeline' ? 'block' : 'none';
          applyFilter();
        });

        bar.addEventListener('click', e => {
          const btn = e.target.closest('.filter-btn');
          if (!btn) return;
          bar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentTag = btn.dataset.tag;
          applyFilter();
        });
      })();
    </script>
  </body>
</html>`;
}

function generateFilename() {
  const now = new Date(new Date().getTime() + 9 * 3600 * 1000); // JST
  const y  = now.getUTCFullYear();
  const m  = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d  = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${hh}${mm}.html`;
}

// ── Git / PR ──────────────────────────────────────────────────────────────────

function createPR(html, filename, channelName, yearMonth) {
  const branch = `auto-summary-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-').replace(/--/g, '-')}`;

  console.log(`\nCreating branch ${branch}...`);
  exec('git checkout main');
  exec(`git checkout -b ${branch}`);

  // Write HTML
  const htmlPath = resolve(ROOT, 'summaries', filename);
  mkdirSync(resolve(ROOT, 'summaries'), { recursive: true });
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`  Written summaries/${filename}`);

  // Commit HTML
  exec(`git add summaries/${filename}`);
  exec(`git commit -m "Add ${yearMonth} Discord summary for #${channelName}"`);

  // Push and create PR
  exec(`git push -u origin ${branch}`);

  const prBody = `Auto generated PR from an AI coding-agent session (generate-summary)\n\nChannel: #${channelName}\nSummary: ${yearMonth}まとめ`;
  const prUrl = exec(
    `gh pr create --title "Added summary ${new Date().toISOString().slice(0, 10)}" --body "${prBody}" --base main`
  );
  console.log(`\nPR created: ${prUrl}`);
  return prUrl;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function deriveYearMonth(channelName) {
  // e.g. 朝活_202604 → 2026年4月
  const ymMatch = channelName.match(/(\d{4})(\d{2})$/);
  return ymMatch
    ? `${ymMatch[1]}年${parseInt(ymMatch[2])}月`
    : `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;
}

// Phase 1: fetch Discord messages and extract the entries that need
// classification. By default this hands classification off to whichever
// coding-agent session is driving the command — Claude Code, Codex, or
// anything else (no API call, no extra cost — runs on that session's own
// model/subscription). If ANTHROPIC_API_KEY is set, it classifies via the
// Anthropic API instead and goes straight to render — useful for headless/CI
// runs with no live agent session attached.
async function runFetch(channelId, channelName) {
  const yearMonth = deriveYearMonth(channelName);

  console.log(`\n=== AI BASE Summary Generator ===`);
  console.log(`Channel: #${channelName} (${channelId})`);
  console.log(`Period:  ${yearMonth}\n`);

  const rawMessages = await fetchMessages(channelId);

  // Save raw messages as response.json (for debugging / manual review)
  const jsonPath = resolve(ROOT, 'summaries', 'response.json');
  writeFileSync(jsonPath, JSON.stringify(rawMessages, null, 2), 'utf-8');
  console.log('  Saved summaries/response.json');

  const processed = processMessages(rawMessages);
  if (processed.length === 0) {
    console.error('No messages with URLs found. Exiting.');
    process.exit(1);
  }

  const processedPath = resolve(tmpdir(), `ai-base-summary-${channelId}.json`);
  writeFileSync(processedPath, JSON.stringify(processed, null, 2), 'utf-8');
  console.log(`  Wrote ${processed.length} processed entries to ${processedPath}`);

  if (ANTHROPIC_KEY) {
    console.log('\nANTHROPIC_API_KEY is set — classifying via the Anthropic API...');
    const classified = await categorizeMessages(processed);
    const classifiedPath = resolve(tmpdir(), `ai-base-summary-${channelId}.classified.json`);
    writeFileSync(classifiedPath, JSON.stringify(classified, null, 2), 'utf-8');
    console.log(`  Wrote classifications to ${classifiedPath}`);
    return runRender(processedPath, classifiedPath, channelName);
  }

  console.log(`
ANTHROPIC_API_KEY is not set — classify these entries yourself (this is the
default path when running inside a coding-agent session such as Claude Code
or Codex), then continue with:

  node scripts/generate-summary.mjs render ${processedPath} <classified.json> ${JSON.stringify(channelName)}

Write a JSON array to <classified.json>, one item per entry:
${JSON.stringify([CLASSIFICATION_ITEM_SHAPE], null, 2)}

${CLASSIFICATION_RULES}`);
}

// Phase 2: merge classifications back into the processed entries, generate
// the HTML, and open the PR.
async function runRender(processedPath, classifiedPath, channelName) {
  const processed = JSON.parse(readFileSync(processedPath, 'utf-8'));
  const classified = JSON.parse(readFileSync(classifiedPath, 'utf-8'));
  const yearMonth = deriveYearMonth(channelName);

  const classMap = Object.fromEntries(classified.map(c => [c.id, c]));
  const entries = processed.map(m => ({
    ...m,
    ...(classMap[m.id] ?? { category: 'other', headline: m.embedTitle || m.url, tags: [] }),
  }));

  console.log('\nGenerating HTML...');
  const filename = generateFilename();
  const html = generateHTML(entries, channelName, yearMonth);
  console.log(`  Filename: ${filename}`);

  createPR(html, filename, channelName, yearMonth);

  console.log('\nDone!');
}

async function main() {
  const [,, arg1, ...rest] = process.argv;

  if (arg1 === 'render') {
    const [processedPath, classifiedPath, channelName] = rest;
    if (!processedPath || !classifiedPath || !channelName) {
      console.error('Usage: node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>');
      process.exit(1);
    }
    return runRender(processedPath, classifiedPath, channelName);
  }

  const channelId = arg1;
  const channelName = rest[0];
  if (!channelId || !channelName) {
    console.error('Usage: node scripts/generate-summary.mjs <channel_id> <channel_name>');
    console.error('   or: node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>');
    console.error('Example: node scripts/generate-summary.mjs 1489234567890 朝活_202604');
    process.exit(1);
  }
  return runFetch(channelId, channelName);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
