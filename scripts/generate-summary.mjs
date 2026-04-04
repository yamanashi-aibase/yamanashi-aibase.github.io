#!/usr/bin/env node
/**
 * AI BASE Discord Monthly Summary Generator
 *
 * Fetches Discord channel messages, categorizes them with Claude,
 * generates a full HTML summary page, and creates a GitHub PR.
 *
 * Usage:
 *   node scripts/generate-summary.mjs <channel_id> <channel_name>
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN  - Discord Bot token (required)
 *   ANTHROPIC_API_KEY  - Anthropic API key (required)
 *
 * Example:
 *   DISCORD_BOT_TOKEN=xxx ANTHROPIC_API_KEY=xxx \
 *     node scripts/generate-summary.mjs 1489234567890 朝活_202604
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
    const embedTitle = msg.embeds?.[0]?.title ?? null;
    const embedDesc  = msg.embeds?.[0]?.description ?? null;

    result.push({ id: msg.id, url, comment, author, date, embedTitle, embedDesc });
  }

  console.log(`  ${result.length} messages with URLs (after dedup)`);
  return result;
}

// ── Claude categorization ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `あなたはAIコミュニティ（AI BASE）のDiscordメッセージを分類する専門家です。
以下のメッセージリストを一括で分析し、JSON配列で返してください。

各アイテムの形式:
{
  "id": "<元のメッセージID>",
  "category": "<カテゴリキー>",
  "headline": "<内容を一行で要約した日本語>",
  "tags": ["#タグ1", "#タグ2"]
}

カテゴリキー（いずれか1つ）:
openai / agent / tool / repository / article / documentation / tutorial / video / other

使用できるタグ（1〜3個）:
#Anthropic #OpenAI #Claude #ClaudeCode #Google #Gemma #モデル
#エージェント #ツール #セキュリティ #解説 #産業 #規約 #MCP
#リポジトリ #ドキュメント #チュートリアル #動画 #Tips #統計 #その他

注意:
- headlineは投稿者のコメントを踏まえて、シェアされたコンテンツの内容を要約すること
- タグはURLのドメインや内容から判断すること（例: anthropic.com → #Anthropic）
- JSONのみ返すこと（説明文不要）`;

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
    if (!jsonMatch) throw new Error(`Unexpected Claude response: ${text.slice(0, 200)}`);

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
          ? `\n                <p class="entry-comment">${escapeHtml(item.comment)}</p>`
          : '';

        lis += `
              <li>
                <span class="entry-date">${escapeHtml(item.date)}</span>
                <strong>${escapeHtml(item.headline)}</strong><br />
                <a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.url)}</a>${comment}
                <div class="entry-tags">
                  ${tags}
                </div>
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
      #tag-filter {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 1.2rem 0 2rem;
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
      li.hidden { display: none; }
      .contributor.hidden { display: none; }
      .category.hidden { display: none; }
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

        <div id="tag-filter"></div>
${sections}
      </article>
    </main>

    <footer>
      <p>&copy; ${new Date().getFullYear()} AI BASE. All rights reserved.</p>
    </footer>

    <script>
      (function () {
        const tagSet = new Set();
        document.querySelectorAll('.entry-tags .tag').forEach(el => tagSet.add(el.textContent.trim()));
        const tags = Array.from(tagSet);

        const bar = document.getElementById('tag-filter');
        const makeBtn = (label, value) => {
          const btn = document.createElement('button');
          btn.className = 'filter-btn' + (value === null ? ' active' : '');
          btn.textContent = label;
          btn.dataset.tag = value ?? '';
          bar.appendChild(btn);
        };
        makeBtn('すべて', null);
        tags.forEach(t => makeBtn(t, t));

        const applyFilter = selectedTag => {
          const all = selectedTag === '';
          document.querySelectorAll('article li').forEach(li => {
            if (all) { li.classList.remove('hidden'); return; }
            const liTags = Array.from(li.querySelectorAll('.entry-tags .tag')).map(el => el.textContent.trim());
            li.classList.toggle('hidden', !liTags.includes(selectedTag));
          });
          document.querySelectorAll('.contributor').forEach(div => {
            div.classList.toggle('hidden', div.querySelectorAll('li:not(.hidden)').length === 0);
          });
          document.querySelectorAll('.category').forEach(sec => {
            sec.classList.toggle('hidden', sec.querySelectorAll('li:not(.hidden)').length === 0);
          });
        };

        bar.addEventListener('click', e => {
          const btn = e.target.closest('.filter-btn');
          if (!btn) return;
          bar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          applyFilter(btn.dataset.tag);
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
  exec(`git commit -m "Added summary with Claude code"`);

  // Push and create PR
  exec(`git push -u origin ${branch}`);

  const prBody = `Auto generated PR from Claude Code\n\nChannel: #${channelName}\nSummary: ${yearMonth}まとめ`;
  const prUrl = exec(
    `gh pr create --title "Added summary ${new Date().toISOString().slice(0, 10)}" --body "${prBody}" --base main`
  );
  console.log(`\nPR created: ${prUrl}`);
  return prUrl;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, channelId, channelName] = process.argv;

  if (!channelId || !channelName) {
    console.error('Usage: node scripts/generate-summary.mjs <channel_id> <channel_name>');
    console.error('Example: node scripts/generate-summary.mjs 1489234567890 朝活_202604');
    process.exit(1);
  }

  // Derive year/month label from channel name (e.g. 朝活_202604 → 2026年4月)
  const ymMatch = channelName.match(/(\d{4})(\d{2})$/);
  const yearMonth = ymMatch
    ? `${ymMatch[1]}年${parseInt(ymMatch[2])}月`
    : `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;

  console.log(`\n=== AI BASE Summary Generator ===`);
  console.log(`Channel: #${channelName} (${channelId})`);
  console.log(`Period:  ${yearMonth}\n`);

  // 1. Fetch
  const rawMessages = await fetchMessages(channelId);

  // Save raw messages as response.json (for debugging / manual review)
  const jsonPath = resolve(ROOT, 'summaries', 'response.json');
  writeFileSync(jsonPath, JSON.stringify(rawMessages, null, 2), 'utf-8');
  console.log('  Saved summaries/response.json');

  // 2. Process
  const processed = processMessages(rawMessages);
  if (processed.length === 0) {
    console.error('No messages with URLs found. Exiting.');
    process.exit(1);
  }

  // 3. Categorize
  console.log('\nCategorizing with Claude...');
  const classified = await categorizeMessages(processed);

  // Merge classification back into processed entries
  const classMap = Object.fromEntries(classified.map(c => [c.id, c]));
  const entries = processed.map(m => ({
    ...m,
    ...(classMap[m.id] ?? { category: 'other', headline: m.embedTitle || m.url, tags: [] }),
  }));

  // 4. Generate HTML
  console.log('\nGenerating HTML...');
  const filename = generateFilename();
  const html = generateHTML(entries, channelName, yearMonth);
  console.log(`  Filename: ${filename}`);

  // 5. Create PR
  createPR(html, filename, channelName, yearMonth);

  console.log('\nDone!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
