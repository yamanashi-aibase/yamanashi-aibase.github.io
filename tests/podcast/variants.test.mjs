import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, fakeQa } from './fixture.mjs';
import { adapt, adaptationBriefs, recordId } from '../../scripts/podcast/variants.mjs';
import { hash, write, validate } from '../../scripts/podcast/core.mjs';
import { release, approve, saveRelease, renderSite } from '../../scripts/podcast/site.mjs';
import { segmentKey } from '../../scripts/podcast/audio.mjs';
import { catalogHtml } from '../../scripts/podcast/catalog.mjs';

const translated = episode => episode.sections.flatMap(s => s.turns.map(t => ({ id: t.id, text: 'これは架空のテスト用の会話だよ。' })));
const approval = record => ({ episodeDigest: record.episodeDigest, audioDigest: record.audioDigest, releaseDigest: hash(record), reviewer: 'Test reviewer', reviewedAt: '2026-10-30T00:00:00Z', listened: true, factsChecked: true, approved: true });

test('adaptation preserves research, IDs, speakers and coverage; separates cache and approval', () => {
  const { inventory, episode, config } = fixture();
  const before = hash(episode), koshu = adapt(inventory, episode, 'koshu', translated(episode));
  validate(inventory, koshu);
  assert.equal(hash(episode), before);
  assert.equal(koshu.adaptedFrom, before);
  assert.deepEqual(koshu.stories, episode.stories);
  assert.deepEqual(koshu.topics, episode.topics);
  assert.deepEqual(koshu.speakers, episode.speakers);
  assert.deepEqual(koshu.sections.map(s => s.turns.map(({text, ...rest}) => rest)), episode.sections.map(s => s.turns.map(({text, ...rest}) => rest)));
  assert.notEqual(segmentKey(koshu.sections[0].turns[0], config), segmentKey(episode.sections[0].turns[0], config));
  const audio = Buffer.from('standard'), record = release(inventory, episode, fakeQa(episode, audio), config, audio);
  assert.throws(() => release(inventory, koshu, fakeQa(episode, audio), config, audio), /stale/);
  const dialectRecord = release(inventory, koshu, fakeQa(koshu, audio), config, audio);
  assert.throws(() => approve(dialectRecord, approval(record)), /does not match/);
});

test('adaptation rejects missing/duplicate/unknown turns and structural changes', () => {
  const { inventory, episode } = fixture(), turns = translated(episode);
  for (const invalid of [turns.slice(1), [...turns, turns[0]], [{...turns[0], id: 'invented'}, ...turns.slice(1)], [{...turns[0], speaker: 'B'}, ...turns.slice(1)]]) {
    assert.throws(() => adapt(inventory, episode, 'koshu', invalid));
  }
  const briefs = adaptationBriefs(inventory, episode, 'koshu');
  assert.equal(briefs.length, episode.sections.length);
  assert.match(briefs[0].prompt, /甲州弁/);
});

test('two editions share one monthly card and unavailable editions have no playable substitute', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('standard');
  const standard = release(inventory, episode, fakeQa(episode, audio), config, audio);
  const dialect = adapt(inventory, episode, 'koshu', translated(episode));
  const koshu = release(inventory, dialect, fakeQa(dialect, audio), config, audio);
  const html = catalogHtml([standard, koshu]);
  assert.equal((html.match(/<article class="episode"/g) || []).length, 1);
  assert.equal((html.match(/<audio /g) || []).length, 2);
  assert.match(html, /id="ep-2026-10-koshu" data-variant="koshu" hidden/);
  assert.match(html, /preload="none"/);
  assert.match(catalogHtml([standard]), /data-edition="koshu" aria-pressed="false" disabled/);
  assert.match(catalogHtml([koshu]), /data-edition="standard" aria-pressed="false" disabled/);
  assert.doesNotMatch(catalogHtml([koshu]), /id="ep-2026-10-koshu" data-variant="koshu" hidden/);
  assert.throws(() => catalogHtml([standard, standard]), /Duplicate/);
});

test('release stores both editions independently; feeds have distinct GUIDs and correct enclosures', () => {
  const { inventory, episode, config } = fixture(), root = mkdtempSync(join(tmpdir(), 'podcast-variants-'));
  try {
    for (const [variant, audio] of [['standard', Buffer.from('standard')], ['koshu', Buffer.from('koshu')]]) {
      const script = variant === 'standard' ? episode : adapt(inventory, episode, variant, translated(episode));
      const record = release(inventory, script, fakeQa(script, audio), config, audio);
      saveRelease(root, approve(record, approval(record)));
      assert.equal(JSON.parse(readFileSync(join(root, 'podcasts/episodes', `${recordId(record)}.json`))).variant, variant);
    }
    const standard = readFileSync(join(root, 'podcasts/feed.xml'), 'utf8');
    const koshu = readFileSync(join(root, 'podcasts/feed-koshu.xml'), 'utf8');
    assert.equal((standard.match(/<item>/g) || []).length, 1);
    assert.equal((koshu.match(/<item>/g) || []).length, 1);
    assert.match(standard, /ai-base-podcast:2026-10<\/guid>/);
    assert.match(koshu, /ai-base-podcast:2026-10-koshu<\/guid>/);
    assert.match(koshu, /#ep-2026-10-koshu/);
    assert.match(koshu, /length="5" type="audio\/mpeg"/);
    renderSite(root, { checkOnly: true });
    // Legacy standard records without variant remain valid, without changing their signed hashes.
    const r = release(inventory, episode, fakeQa(episode, Buffer.from('x')), config, Buffer.from('x'));
    delete r.variant;
    write(join(root, 'podcasts/episodes/2026-10.json'), approve(r, approval(r)));
    renderSite(root);
  } finally { rmSync(root, { recursive: true }); }
});
