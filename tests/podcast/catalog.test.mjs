import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeQa } from './fixture.mjs';
import { release } from '../../scripts/podcast/site.mjs';
import { catalogHtml } from '../../scripts/podcast/catalog.mjs';

test('one catalog contains multiple months in newest-first order with separate audio controls', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('fixture');
  const current = release(inventory, episode, fakeQa(episode, audio), config, audio);
  const previous = { ...current, month: '2026-09', title: 'September', audioUrl: 'https://example.com/september.mp3' };
  const html = catalogHtml([previous, current]);
  assert(html.indexOf('id="ep-2026-10"') < html.indexOf('id="ep-2026-09"'));
  assert.equal((html.match(/<audio /g) || []).length, 2);
  assert(html.includes('id="ep-2026-09-audio"'));
  assert(html.includes('data-player="ep-2026-10-audio" data-seek="5"'));
  assert(html.includes('src="https://example.com/september.mp3"'));
});
test('local player uses local audio without altering the release URL and rejects unsafe paths', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('fixture');
  const record = release(inventory, episode, fakeQa(episode, audio), config, audio);
  const url = record.audioUrl;
  const html = catalogHtml([record], { preview: true, audioByMonth: { '2026-10': 'episode.mp3' } });
  assert(html.includes('src="episode.mp3"')); assert.equal(record.audioUrl, url);
  for (const unsafe of ['../secret.mp3', 'javascript:alert(1)', '/tmp/secret.mp3']) assert.throws(() => catalogHtml([record], { preview: true, audioByMonth: { '2026-10': unsafe } }));
});

test('long archives retain a single month selector, year headings, and lazy audio', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('fixture');
  const current = release(inventory, episode, fakeQa(episode, audio), config, audio);
  const records = Array.from({length: 36}, (_, i) => ({ ...current, month: `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}` }));
  const html = catalogHtml(records);
  assert.equal((html.match(/<article class="episode"/g) || []).length, 36);
  assert.equal((html.match(/class="year-heading"/g) || []).length, 3);
  assert.equal((html.match(/id="month-jump"/g) || []).length, 1);
  assert.equal((html.match(/preload="none"/g) || []).length, 36);
  assert(html.indexOf('id="month-2026-12"') < html.indexOf('id="month-2024-01"'));
  assert.match(html, /feed-koshu.xml/);
});
