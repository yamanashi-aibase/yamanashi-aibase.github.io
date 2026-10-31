import { readFileSync } from 'node:fs';
import { escape as h } from './html.mjs';
import { https, assert } from './core.mjs';
import { edition, editionLabel, recordId } from './variants.mjs';

const css = readFileSync(new URL('./catalog.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('./player.js', import.meta.url), 'utf8');
const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function panel(r, { preview, audioByMonth }, hidden) {
  const source = preview ? audioByMonth[recordId(r)] : r.audioUrl;
  if (preview) assert(typeof source === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.mp3$/.test(source) && !source.split('/').includes('..'), 'Local preview needs a relative MP3 path');
  else https(source);
  const id = `ep-${recordId(r)}`, label = editionLabel(edition(r));
  const chapters = (r.chapters || []).map(c => `<button type="button" class="chapter" data-player="${id}-audio" data-seek="${Number(c.startSeconds)}"><span>${duration(c.startSeconds)}</span>${h(c.title)}</button>`).join('');
  const notes = r.notes.map(n => `<section class="source"><h4>${h(n.title)}</h4>${n.disposition === 'notes_only' ? `<p>音声では省略：${h(n.reason)}</p>` : ''}<ul>${n.sources.map(s => { https(s.url); return `<li><a href="${h(s.url)}" target="_blank" rel="noopener noreferrer">${h(s.title)}</a></li>`; }).join('')}</ul>${n.claims.map(c => `<p>${h(c.text)}${c.certainty === 'reported' ? '（未検証の報道・投稿として紹介）' : ''}</p><ul>${c.evidence.map(e => { https(e.url); return `<li><a href="${h(e.url)}" target="_blank" rel="noopener noreferrer">調査根拠</a> · ${h(e.accessedAt)}確認</li>`; }).join('')}</ul>`).join('')}</section>`).join('');
  return `<div class="edition-panel" id="${id}" data-variant="${edition(r)}"${hidden ? ' hidden' : ''}>
    <p class="episode-meta">${label} · ${duration(Math.round(r.duration))} · ${h(r.speakers.A)} &amp; ${h(r.speakers.B)}<a class="permalink" href="#${id}" aria-label="${r.month} ${label}へのリンク">#</a></p>
    <div class="player"><audio id="${id}-audio" controls preload="none" aria-label="${r.month} ${label}" src="${h(source)}"></audio>
      <div class="player-tools"><button type="button" data-player="${id}-audio" data-skip="-15" aria-label="${r.month} ${label} 15秒戻る">−15秒</button><button type="button" data-player="${id}-audio" data-skip="15" aria-label="${r.month} ${label} 15秒進む">＋15秒</button><label>速度 <select data-player="${id}-audio" aria-label="${r.month} ${label}の再生速度"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><a class="download" href="${h(source)}">MP3</a></div>
      <p class="audio-error" role="status" hidden>音声を読み込めませんでした。<a href="${h(source)}">MP3を開く</a></p>
    </div>
    <details class="episode-details"><summary>チャプター・文字起こし</summary>${chapters ? `<nav class="chapters" aria-label="${r.month} ${label}のチャプター">${chapters}</nav>` : ''}${r.transcript.map(s => `<section class="transcript"><h3>${h(s.title)}</h3>${s.turns.map(t => `<p><strong>${h(t.speaker)}</strong><span>${h(t.text)}</span></p>`).join('')}</section>`).join('')}</details>
    <details class="episode-details"><summary>ニュース・出典</summary>${notes}</details>
  </div>`;
}

export function catalogHtml(records, { preview = false, audioByMonth = {}, assetBase } = {}) {
  const seen = new Set(), months = new Map();
  for (const r of [...records].sort((a, b) => b.month.localeCompare(a.month) || edition(a).localeCompare(edition(b)))) {
    assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month), 'Invalid episode month');
    assert(['standard', 'koshu'].includes(edition(r)) && !seen.has(recordId(r)), 'Duplicate or invalid edition');
    seen.add(recordId(r));
    if (!months.has(r.month)) months.set(r.month, []);
    months.get(r.month).push(r);
  }
  const assets = assetBase ?? (preview ? 'https://aibase.yamanashi.dev/' : '../');
  assert(assets === '../' || assets === 'https://aibase.yamanashi.dev/', 'Invalid asset base');
  let year = '', cards = '';
  for (const [month, editions] of months) {
    const [y, m] = month.split('-');
    if (y !== year) { year = y; cards += `<h2 class="year-heading" id="year-${y}">${y}年</h2>`; }
    const selected = editions.find(r => edition(r) === 'standard') || editions[0];
    const buttons = ['standard', 'koshu'].map(variant => {
      const available = editions.find(r => edition(r) === variant);
      return `<button type="button" data-edition="${variant}" aria-pressed="${edition(selected) === variant}"${available ? ` aria-controls="ep-${recordId(available)}"` : ' disabled'}>${editionLabel(variant)}${available ? '' : '<span class="unavailable">未公開</span>'}</button>`;
    }).join('');
    cards += `<article class="episode" id="month-${month}" aria-labelledby="title-${month}"><div class="episode-heading"><h3 id="title-${month}">${y}年${Number(m)}月</h3>${month === months.keys().next().value ? '<span class="latest">最新</span>' : ''}</div><p class="episode-title">${h(selected.title)}</p><div class="edition-switch" role="group" aria-label="${month}の音声バージョン">${buttons}</div>${editions.map(r => panel(r, { preview, audioByMonth }, r !== selected)).join('')}</article>`;
  }
  const options = [...months.keys()].map(month => `<option value="month-${month}">${month.replace('-', '年')}月</option>`).join('');
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="AI BASEの月次Podcast"><title>Podcast | AI BASE</title><link rel="stylesheet" href="${assets}style.css">${preview ? '<meta name="robots" content="noindex">' : '<link rel="alternate" type="application/rss+xml" title="AI BASE Podcast（標準語）" href="feed.xml"><link rel="alternate" type="application/rss+xml" title="AI BASE Podcast（甲州弁）" href="feed-koshu.xml">'}<style>${css}</style><noscript><style>.edition-panel[hidden]{display:block!important}.edition-switch{display:none}</style></noscript></head>
<body class="podcast-page"><header><div class="logo-container"><a href="${assets}index.html"><img class="logo" src="${assets}img/yamanashi-aibase.png" alt="AI BASE Logo"></a></div><h1>AI BASE</h1><p class="tagline"><a href="${assets}index.html">← 月次まとめ</a></p></header>
<main><div class="catalog-heading"><h1>Podcast</h1>${preview ? '<span class="preview">プレビュー</span>' : '<details class="rss-menu"><summary>RSSで購読</summary><a href="feed.xml">標準語 RSS</a><a href="feed-koshu.xml">甲州弁 RSS</a></details>'}</div><div class="catalog-tools"><p>AIニュースを、月に一度。<span class="synthetic">AI合成音声</span></p>${months.size ? `<label>月を選ぶ <select id="month-jump"><option value="">エピソードへ移動</option>${options}</select></label>` : ''}</div>${cards || '<div class="empty">エピソードを準備しています。</div>'}</main><footer><p>© AI BASE</p></footer><script>${script}</script></body></html>\n`;
}
