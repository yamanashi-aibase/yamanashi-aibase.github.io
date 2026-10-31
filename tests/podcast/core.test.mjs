import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest, validate, briefs, hash } from '../../scripts/podcast/core.mjs';
import { validateSchema } from '../../scripts/podcast/schema.mjs';
import { segments, segmentKey, synthesize, tone } from '../../scripts/podcast/audio.mjs';
import { approve, release, renderSite, saveRelease, escape } from '../../scripts/podcast/site.mjs';
import { fixture, fakeQa } from './fixture.mjs';

test('existing processed JSON: retains every entry and strips private fields/tracking', () => {
  const { processed, inventory } = fixture();
  assert.equal(inventory.sources.length, processed.length);
  assert.equal(inventory.sources[0].url, 'https://example.com/launch');
  assert(!JSON.stringify(inventory).includes('fixture-user'));
  assert(!JSON.stringify(inventory).includes('fixture-1'));
  const duplicateUrl = [...processed, { ...processed[0], id: 'another-message' }];
  assert.equal(ingest(duplicateUrl, '2026-10').inventory.sources.length, 4);
  assert.throws(() => ingest([...processed, processed[0]], '2026-10'), /Duplicate/);
  assert.throws(() => ingest(processed, '2026-13'), /month/);
  assert.throws(() => ingest([{ id: 'bad', url: 'javascript:alert(1)' }], '2026-10'), /HTTPS/);
});
test('optional existing classifications are complete and become hints', () => {
  const { processed } = fixture();
  const classification = processed.map(x => ({ id: x.id, headline: '見出し', category: '動向', tags: [] }));
  const { inventory } = ingest(processed, '2026-10', classification);
  assert.equal(inventory.sources[0].categoryHint, '動向');
  assert.throws(() => ingest(processed, '2026-10', classification.slice(1)), /cover/);
});
test('Source→Story→Topic consolidation and notes-only coverage pass', () => {
  const { inventory, episode } = fixture();
  assert.deepEqual(validate(inventory, episode), { stage: 'script', sources: 3, stories: 2, topics: 1, budgetSeconds: 1590, spoken: 1, notesOnly: 1 });
  assert.equal(briefs(inventory, episode).length, 3);
});
test('coverage holes, duplicate assignments and invented references fail', () => {
  for (const mutate of [
    e => e.stories[0].sourceIds.pop(),
    e => e.stories[1].sourceIds.push('source-1'),
    e => e.topics[0].storyIds.pop(),
    e => e.sections[0].topicIds.push('topic-1'),
    e => e.stories[0].topicId = 'unknown',
    e => e.sections[1].turns[0].claimIds = ['fake-claim']
  ]) { const { inventory, episode } = fixture(); mutate(episode); assert.throws(() => validate(inventory, episode)); }
});
test('unresearched, unsupported, missing dialogue, and too long scripts fail', () => {
  for (const mutate of [
    e => e.stories[0].claims = [],
    e => e.stories[0].claims[0].evidence[0].kind = 'secondary',
    e => e.stories[1].reason = '',
    e => e.sections[1].turns.forEach(t => { t.claimIds = []; t.storyIds = []; }),
    e => e.sections[0].turns = [],
    e => e.sections[1].seconds = 1740,
    e => e.sections[0].turns[0].text = 'あ'.repeat(1000),
    e => e.sections[1].turns.forEach(t => t.speaker = 'A')
  ]) { const { inventory, episode } = fixture(); mutate(episode); if (episode.sections[1].turns.every(t => t.speaker === 'A')) episode.sections.forEach(s => s.turns.forEach(t => t.speaker = 'A')); assert.throws(() => validate(inventory, episode)); }
});
test('inventory tampering and unknown fields fail closed', () => {
  const { inventory, episode } = fixture();
  inventory.sources.pop(); assert.throws(() => validate(inventory, episode), /digest/);
  assert.throws(() => validateSchema({}, { type: 'object', unimplemented: true }), /Unsupported/);
  const other = fixture(); other.episode.secret = 'no'; assert.throws(() => validate(other.inventory, other.episode), /unexpected/);
  const prototypeKey = fixture(); prototypeKey.episode.constructor = 'unexpected'; assert.throws(() => validate(prototypeKey.inventory, prototypeKey.episode), /unexpected/);
});
test('dry-run never calls paid API; segment IDs and cache keys are stable', async () => {
  const { episode, config } = fixture();
  config.tts.provider = 'openai-compatible';
  const dir = mkdtempSync(join(tmpdir(), 'podcast-dry-'));
  assert.equal((await segments(episode, config, dir)).segments.length, 6);
  assert.deepEqual((await segments(episode, config, dir, { segment: 'turn-0-a' })).segments, ['turn-0-a']);
  await assert.rejects(segments(episode, config, dir, { segment: '../secret' }), /Unknown/);
  const t = episode.sections[0].turns[0], key = segmentKey(t, config);
  assert.notEqual(key, segmentKey({ ...t, text: t.text + '変更' }, config));
  config.tts.voices.A = 'new'; assert.notEqual(key, segmentKey(t, config));
});
test('TTS adapter sends configured voice and API contract, rejects bad responses', async () => {
  const { episode, config } = fixture(); config.tts.provider = 'openai-compatible';
  config.tts.apiKeyEnv = 'PODCAST_TEST_KEY'; process.env.PODCAST_TEST_KEY = 'fixture-key';
  const turn = episode.sections[0].turns[0];
  try {
    const audio = await synthesize(turn, config, async (url, options) => {
      assert.equal(url, config.tts.endpoint); assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).voice, config.tts.voices.A);
      assert.equal(options.headers.Authorization, 'Bearer fixture-key');
      return new Response(tone(turn), { status: 200 });
    }); assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    await assert.rejects(synthesize(turn, config, async () => new Response('secret', { status: 401 })), /HTTP 401/);
    await assert.rejects(synthesize(turn, config, async () => new Response('not audio')), /WAVE/);
  } finally { delete process.env.PODCAST_TEST_KEY; }
});
test('release binds approval to exact script, audio, and public metadata', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('fixture audio');
  const qa = fakeQa(episode, audio), r = release(inventory, episode, qa, config, audio);
  const a = { episodeDigest: r.episodeDigest, audioDigest: r.audioDigest, releaseDigest: hash(r), reviewer: 'human fixture', reviewedAt: '2026-10-25T00:00:00Z', listened: true, factsChecked: true, approved: true };
  assert.equal(approve(r, a).approval.reviewer, 'human fixture');
  assert.throws(() => approve({ ...r, title: 'changed' }, a), /Approval/);
  assert.throws(() => approve(r, { ...a, listened: false }));
  assert.throws(() => release(inventory, episode, { ...qa, provider: 'mock-tone' }, config, audio), /mock/);
  assert.throws(() => release(inventory, episode, qa, config, Buffer.from('changed')), /stale/);
  episode.title = 'edited'; assert.throws(() => release(inventory, episode, qa, config, audio), /stale/);
});
test('Pages/RSS have external enclosures, escaped text, notes and no raw data', () => {
  const { inventory, episode, config } = fixture(), audio = Buffer.from('fixture audio');
  episode.title = '<script>alert(1)</script>';
  const r = release(inventory, episode, fakeQa(episode, audio), config, audio);
  const approved = approve(r, { episodeDigest: r.episodeDigest, audioDigest: r.audioDigest, releaseDigest: hash(r), reviewer: 'human fixture', reviewedAt: '2026-10-25T00:00:00Z', listened: true, factsChecked: true, approved: true });
  const root = mkdtempSync(join(tmpdir(), 'podcast-site-')); saveRelease(root, approved);
  const html = readFileSync(join(root, 'podcasts/index.html'), 'utf8');
  assert(!html.includes('<script>alert(1)</script>')); assert(html.includes('&lt;script&gt;'));
  assert(html.includes('音声では省略')); assert(html.includes('文字起こし'));
  const feed = readFileSync(join(root, 'podcasts/feed.xml'), 'utf8');
  assert(feed.includes(`length="${audio.length}" type="audio/mpeg"`));
  assert(feed.includes('<pubDate>')); assert(feed.includes('ai-base-podcast:2026-10'));
  assert(feed.includes('/podcasts/index.html#ep-2026-10'));
  assert(html.includes(`src="${r.audioUrl}"`));
  assert(html.includes('data-seek="5"'));
  assert(readFileSync(join(root, 'podcasts/2026-10.html'), 'utf8').includes('index.html#ep-2026-10'));
  assert(!JSON.stringify(approved).includes('fixture-user'));
  assert.equal(renderSite(root, { checkOnly: true }).episodes, 1);
  writeFileSync(join(root, 'podcasts/index.html'), 'stale'); assert.throws(() => renderSite(root, { checkOnly: true }), /out of date/);
  assert.equal(escape('"<&'), '&quot;&lt;&amp;');
});
