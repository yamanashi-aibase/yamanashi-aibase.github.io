import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { segments, assemble, quality, ffmpeg, tone } from '../../scripts/podcast/audio.mjs';
import { fixture } from './fixture.mjs';

const available = !spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version']).error && !spawnSync(process.env.FFPROBE || 'ffprobe', ['-version']).error;
// CI installs both tools. Local source tests can run before installation.
test('offline FFmpeg: segment cache, regeneration, normalized MP3 and QA', { skip: !available && 'Install ffmpeg/ffprobe to run audio integration' }, async () => {
  const { episode, config } = fixture(), dir = mkdtempSync(join(tmpdir(), 'podcast-audio-'));
  assert.equal((await segments(episode, config, dir, { execute: true })).generated.length, 6);
  assert.equal((await segments(episode, config, dir, { execute: true })).generated.length, 0);
  const untouched = readFileSync(join(dir, 'turn-0-b.wav'));
  assert.deepEqual((await segments(episode, config, dir, { execute: true, segment: 'turn-0-a' })).generated, ['turn-0-a']);
  assert.deepEqual(readFileSync(join(dir, 'turn-0-b.wav')), untouched);
  const output = join(dir, 'episode.mp3'), qa = assemble(episode, config, dir, output);
  assert.equal(qa.passed, true); assert(qa.duration > 0 && qa.duration < 1800); assert.equal(qa.bytes, readFileSync(output).length);
  writeFileSync(join(dir, 'turn-0-a.wav'), 'corrupt'); assert.throws(() => assemble(episode, config, dir, output), /corrupt/);
  assert.deepEqual((await segments(episode, config, dir, { execute: true })).generated, ['turn-0-a']);
  episode.sections[0].turns[0].text += '変更'; assert.throws(() => assemble(episode, config, dir, output), /stale/);
});
test('offline FFmpeg rejects silent, clipped and overlong final audio', { skip: !available && 'Install ffmpeg/ffprobe to run audio integration' }, () => {
  const { episode } = fixture(), dir = mkdtempSync(join(tmpdir(), 'podcast-qa-'));
  const silent = join(dir, 'silent.mp3');
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '10', '-c:a', 'libmp3lame', silent]);
  assert.throws(() => quality(episode, silent, {}, 'mock-tone'), /Loudness/);
  const loud = join(dir, 'loud.mp3');
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-af', 'volume=10', '-c:a', 'libmp3lame', loud]);
  assert.throws(() => quality(episode, loud, {}, 'mock-tone'), /Loudness|Peak/);
  const long = join(dir, 'long.mp3');
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1801', '-c:a', 'libmp3lame', '-b:a', '32k', long]);
  assert.throws(() => quality(episode, long, {}, 'mock-tone'), /duration/);
});
