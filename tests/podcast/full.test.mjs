import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './fixture.mjs';
import { write, read, hash } from '../../scripts/podcast/core.mjs';
import { tone } from '../../scripts/podcast/audio.mjs';
import { generateFull } from '../../scripts/podcast/full.mjs';

const available = !spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version']).error && !spawnSync(process.env.FFPROBE || 'ffprobe', ['-version']).error;
test('full render resumes after API failure, reuses segments, checks MP3, and prepares unapproved preview', { skip: !available && 'Install ffmpeg/ffprobe' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'podcast-full-')), directory = join(root, 'work/episode'), output = join(root, 'output');
  const { episode, inventory, config } = fixture();
  Object.assign(config.tts, { provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash-tts', apiKeyEnv: 'PODCAST_FULL_TEST_KEY' });
  write(join(directory, 'episode.json'), episode); write(join(directory, 'inventory.json'), inventory); write(join(directory, 'gemini.config.json'), config);
  const keyFile = join(directory, 'key.txt'); writeFileSync(keyFile, 'fixture-secret-never-print', { mode: 0o600 });
  const logs = [], options = { root, directory, output, keyFile, intervalSeconds: 0, log: s => logs.push(s) };
  const originalFetch = globalThis.fetch;
  let calls = 0, fail = true;
  globalThis.fetch = async (_, request) => {
    calls++;
    if (fail && calls === 2) return new Response('', { status: 429 });
    const body = JSON.parse(request.body), text = body.contents[0].parts[0].text;
    const speaker = body.generationConfig.speechConfig.voiceConfig.voice === config.tts.voices.A ? 'A' : 'B';
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: tone({ text, speaker }).toString('base64') } }] } }] });
  };
  try {
    const dry = await generateFull(options); assert.equal(dry.pendingTurns, 6); assert.equal(calls, 0);
    await assert.rejects(generateFull({ ...options, execute: true }), /429/);
    assert(!existsSync(join(output, 'episode.mp3')));
    const firstFile = join(directory, 'segments/turn-0-a.wav'), saved = hash(readFileSync(firstFile));
    fail = false;
    assert.equal((await generateFull({ ...options, execute: true })).qaPassed, true);
    assert.equal(calls, 7); assert.equal(hash(readFileSync(firstFile)), saved);
    assert.equal(read(join(output, 'validation.json')).approved, false);
    assert.equal(read(join(output, 'validation.json')).audioGenerated, true);
    assert(readFileSync(join(output, 'review.html'), 'utf8').includes('src="episode.mp3"'));
    unlinkSync(keyFile);
    await generateFull({ ...options, execute: true }); assert.equal(calls, 7);
    assert(!logs.join('\n').includes('fixture-secret-never-print'));
    assert.equal(process.env.PODCAST_FULL_TEST_KEY, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
