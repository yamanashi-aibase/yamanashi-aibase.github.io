import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, hash, https, read, write, validate } from './core.mjs';
import { check } from './schema.mjs';

import { escape } from './html.mjs';
export { escape } from './html.mjs';
import { catalogHtml } from './catalog.mjs';
import { edition, recordId } from './variants.mjs';

export function destination(episode, qa, config) {
  check(config, 'config');
  const key = `${episode.month}/${qa.audioDigest}.mp3`;
  return { key, url: `${config.storage.publicBaseUrl.replace(/\/$/, '')}/${key}` };
}
export function release(inventory, episode, qa, config, audio) {
  validate(inventory, episode);
  check(config, 'config');
  assert(qa.passed === true && ['openai-compatible', 'gemini'].includes(qa.provider), 'Only checked spoken TTS can be released; mock tones cannot be published');
  assert(qa.episodeDigest === hash(episode) && qa.audioDigest === hash(audio) && qa.bytes === audio.length, 'QA report is stale');
  assert(Number.isFinite(qa.duration) && qa.duration > 0 && qa.duration <= 1800, 'Invalid QA duration');
  assert(Number.isFinite(qa.integratedLufs) && qa.integratedLufs >= -18 && qa.integratedLufs <= -14 && Number.isFinite(qa.truePeakDb) && qa.truePeakDb <= -1 && qa.longestSilence <= 8, 'Invalid QA measurements');
  for (const section of episode.sections) assert(Number.isFinite(qa.sectionDurations[section.id]) && qa.sectionDurations[section.id] > 0 && qa.sectionDurations[section.id] <= section.seconds * 1.1, `Invalid section QA: ${section.id}`);
  https(config.site.baseUrl); https(config.site.imageUrl);
  let elapsed = 0;
  const chapters = episode.sections.map(section => { const chapter = { title: section.title, startSeconds: Number(elapsed.toFixed(3)) }; elapsed += qa.sectionDurations[section.id]; return chapter; });
  return { variant: edition(episode), chapters, version: 1, month: episode.month, title: episode.title, description: episode.description, episodeDigest: hash(episode), audioDigest: qa.audioDigest, audioUrl: destination(episode, qa, config).url, bytes: qa.bytes, duration: qa.duration, site: config.site, speakers: episode.speakers,
    transcript: episode.sections.map(s => ({ title: s.title, turns: s.turns.map(t => ({ speaker: episode.speakers[t.speaker], text: t.text })) })),
    notes: episode.stories.map(s => ({ title: s.title, disposition: s.disposition, reason: s.reason, sources: s.sourceIds.map(id => { const source = inventory.sources.find(x => x.id === id); return { title: source.title, url: source.url }; }), claims: s.claims.map(c => ({ text: c.text, certainty: c.certainty, evidence: c.evidence.map(e => ({ url: e.url, accessedAt: e.accessedAt, kind: e.kind })) })) })) };
}
export function approve(record, approval) {
  check(approval, 'approval');
  assert(approval.episodeDigest === record.episodeDigest && approval.audioDigest === record.audioDigest && approval.releaseDigest === hash(record), 'Approval does not match the exact script/audio/release metadata');
  assert(!Number.isNaN(Date.parse(approval.reviewedAt)) && Date.parse(approval.reviewedAt) <= Date.now() + 60000, 'Invalid approval time');
  return { ...record, approval };
}
function shell(title, content, base = '../') {
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="${base}style.css"><link rel="alternate" type="application/rss+xml" title="AI BASE Podcast" href="${base}podcasts/feed.xml"><style>main{max-width:900px;margin:auto;padding:2rem}audio{width:100%}article{margin:2rem 0}p{line-height:1.9}.note{color:#666}</style></head><body><header><h1>AI BASE Podcast</h1><a href="${base}index.html">AI BASE ホーム</a></header><main>${content}</main></body></html>\n`;
}
export function episodeHtml(r, { preview = false } = {}) {
  https(r.audioUrl);
  const audioSrc = preview ? 'episode.mp3' : r.audioUrl;
  const notes = r.notes.map(n => `<article><h3>${escape(n.title)}</h3>${n.disposition === 'notes_only' ? `<p class="note">音声では省略：${escape(n.reason)}</p>` : ''}<ul>${n.sources.map(s => { https(s.url); return `<li><a href="${escape(s.url)}" rel="noopener noreferrer">${escape(s.title)}</a></li>`; }).join('')}</ul>${n.claims.map(c => `<p>${escape(c.text)}${c.certainty === 'reported' ? '（未検証の報道・投稿として紹介）' : ''}</p><ul>${c.evidence.map(e => { https(e.url); return `<li><a href="${escape(e.url)}">調査根拠（${escape(e.kind)}）</a>：${escape(e.accessedAt)}確認</li>`; }).join('')}</ul>`).join('')}</article>`).join('');
  return shell(r.title, `${preview ? '<p><strong>人間レビュー待ち・非公開プレビュー</strong></p>' : '<a href="index.html">Podcast一覧</a>'}<h2>${escape(r.title)}</h2><p>${escape(r.description)}</p><p>${Math.ceil(r.duration / 60)}分・AI合成音声による2人対話${preview ? '' : '・人間レビュー済み'}</p><audio controls preload="none" src="${escape(audioSrc)}"></audio><p><a href="${escape(audioSrc)}">MP3を開く</a>${preview ? '' : ' · <a href="feed.xml">RSS</a>'}</p><h2>ニュースと調査根拠</h2>${notes}<h2>文字起こし</h2>${r.transcript.map(s => `<section><h3>${escape(s.title)}</h3>${s.turns.map(t => `<p><strong>${escape(t.speaker)}</strong>：${escape(t.text)}</p>`).join('')}</section>`).join('')}`, preview ? r.site.baseUrl.replace(/\/$/, '') + '/' : '../');
}
export function renderSite(root, { checkOnly = false } = {}) {
  const dir = join(root, 'podcasts'), recordsDir = join(dir, 'episodes');
  const records = existsSync(recordsDir) ? readdirSync(recordsDir).map(f => {
    assert(/^\d{4}-\d{2}(-koshu)?\.json$/.test(f), `Unexpected file in public episode data: ${f}`);
    const record = read(join(recordsDir, f));
    assert(f === `${recordId(record)}.json`, `Episode filename/month mismatch: ${f}`);
    return record;
  }) : [];
  records.sort((a, b) => b.month.localeCompare(a.month));
  const months = new Set();
  for (const r of records) {
    check(r, 'published');
    assert(!months.has(recordId(r)), 'Only one episode per month and variant'); months.add(recordId(r));
    const { approval, ...record } = r; approve(record, approval);
    assert(r.duration > 0 && r.duration <= 1800 && r.bytes > 0, 'Invalid enclosure metadata');
    https(r.audioUrl); https(r.site.baseUrl); https(r.site.imageUrl);
  }
  if (records.length) assert(records.every(r => JSON.stringify(r.site) === JSON.stringify(records[0].site)), 'Site metadata differs across releases; migrate all records explicitly');
  const site = records[0]?.site || { title: 'AI BASE Podcast', description: '月に一度、AIニュースを2人対話で振り返ります。', baseUrl: 'https://aibase.yamanashi.dev', author: 'AI BASE', email: '', imageUrl: 'https://aibase.yamanashi.dev/img/yamanashi-aibase.png' };
  const feed = variant => {
    const selected = records.filter(r => edition(r) === variant);
    const suffix = variant === 'koshu' ? '-koshu' : '';
    const base = site.baseUrl.replace(/\/$/, '');
    const items = selected.map(r => `<item><title>${escape(r.title)}${variant === 'koshu' ? '（甲州弁）' : ''}</title><description>${escape(r.description)}</description><link>${escape(base)}/podcasts/index.html#ep-${recordId(r)}</link><guid isPermaLink="false">ai-base-podcast:${recordId(r)}</guid><pubDate>${new Date(r.approval.reviewedAt).toUTCString()}</pubDate><enclosure url="${escape(r.audioUrl)}" length="${r.bytes}" type="audio/mpeg"/><itunes:duration>${Math.ceil(r.duration)}</itunes:duration><itunes:explicit>false</itunes:explicit></item>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escape(site.title)}${variant === 'koshu' ? '（甲州弁）' : ''}</title><description>${escape(site.description)}</description><link>${escape(base)}/podcasts/</link><language>ja</language><atom:link href="${escape(base)}/podcasts/feed${suffix}.xml" rel="self" type="application/rss+xml"/><itunes:author>${escape(site.author)}</itunes:author><itunes:explicit>false</itunes:explicit><itunes:image href="${escape(site.imageUrl)}"/>${site.email ? `<itunes:owner><itunes:name>${escape(site.author)}</itunes:name><itunes:email>${escape(site.email)}</itunes:email></itunes:owner>` : ''}${items}</channel></rss>\n`;
  };
  const files = new Map([
    ['index.html', catalogHtml(records)], ['feed.xml', feed('standard')], ['feed-koshu.xml', feed('koshu')]
  ]);
  records.forEach(r => files.set(`${recordId(r)}.html`, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=index.html#ep-${recordId(r)}"><title>${escape(r.title)}</title><p><a href="index.html#ep-${recordId(r)}">Podcastの再生ページへ</a></p></html>\n`));
  if (!checkOnly) mkdirSync(dir, { recursive: true });
  for (const [file, content] of files) {
    const path = join(dir, file);
    if (checkOnly) assert(existsSync(path) && readFileSync(path, 'utf8') === content, `Generated page out of date: ${file}`);
    else writeFileSync(path, content);
  }
  if (existsSync(dir)) for (const file of readdirSync(dir)) if (/^\d{4}-\d{2}(-koshu)?\.html$/.test(file)) assert(files.has(file), `Orphan episode page: ${file}`);
  return { episodes: records.length, files: [...files.keys()] };
}
export function saveRelease(root, record) {
  check(record, 'published');
  const path = join(root, 'podcasts', 'episodes', `${recordId(record)}.json`);
  if (existsSync(path)) assert(hash(read(path)) === hash(record), 'Month/variant already released; explicit editorial correction required');
  write(path, record);
  return renderSite(root);
}
