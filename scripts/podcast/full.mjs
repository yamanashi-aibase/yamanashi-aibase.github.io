import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, write, assert, validate, hash } from './core.mjs';
import { check } from './schema.mjs';
import { segments, assemble, run } from './audio.mjs';
import { release, episodeHtml } from './site.mjs';
import { catalogHtml } from './catalog.mjs';
import { recordId } from './variants.mjs';
import { writeFileSync } from 'node:fs';

// Complete local render. No upload, Git operations, approval or publication.
export async function generateFull({ root, directory, output, keyFile, execute = false, intervalSeconds = 20, log = console.log }) {
  assert(root && directory && output, 'Root, episode directory, and output directory are required');
  assert(Number.isFinite(intervalSeconds) && intervalSeconds >= 0 && intervalSeconds <= 60, 'Interval must be 0–60 seconds');
  const episode = read(join(directory, 'episode.json'));
  const inventory = read(join(directory, 'inventory.json'));
  const config = read(join(directory, 'gemini.config.json'));
  const validation = validate(inventory, episode);
  check(config, 'config');
  const cache = join(directory, 'segments');
  const plan = await segments(episode, config, cache);
  const summary = { dryRun: !execute, month: episode.month, speakers: episode.speakers, provider: config.tts.provider, model: config.tts.model, totalTurns: episode.sections.flatMap(s => s.turns).length, pendingTurns: plan.segments.length, pendingCharacters: plan.characters, intervalSeconds };
  log(JSON.stringify(summary, null, 2));
  if (!execute) return summary;
  assert(['gemini', 'openai-compatible'].includes(config.tts.provider), 'Full episode requires a spoken TTS provider');
  for (const [env, name] of [['FFMPEG', 'ffmpeg'], ['FFPROBE', 'ffprobe']]) {
    const bundled = join(root, 'work/tools', name);
    if (!process.env[env] && existsSync(bundled)) process.env[env] = bundled;
    run(process.env[env] || name, ['-version']);
  }
  const priorKey = process.env[config.tts.apiKeyEnv];
  try {
    if (plan.segments.length) {
      const key = keyFile ? readFileSync(keyFile, 'utf8').trim() : priorKey;
      assert(key && !/\s/.test(key), 'Expected one API key in the key file or configured environment variable');
      process.env[config.tts.apiKeyEnv] = key;
    }
    await segments(episode, config, cache, { execute: true, minIntervalMs: intervalSeconds * 1000, onProgress: p => log(`${p.phase === 'complete' ? '保存済み' : '音声生成'} ${p.index}/${p.total}: ${p.id}`) });
  } finally {
    if (priorKey === undefined) delete process.env[config.tts.apiKeyEnv];
    else process.env[config.tts.apiKeyEnv] = priorKey;
  }
  log('全発言を連結し、音量と完成音声を検証しています。');
  const audioPath = join(output, 'episode.mp3');
  const qa = assemble(episode, config, cache, audioPath);
  write(join(directory, 'qa.json'), qa);
  write(join(output, 'qa.json'), qa);
  const record = release(inventory, episode, qa, config, readFileSync(audioPath));
  writeFileSync(join(output, 'review.html'), episodeHtml(record, { preview: true }));
  writeFileSync(join(output, 'index.html'), catalogHtml([record], { preview: true, audioByMonth: { [recordId(record)]: 'episode.mp3' } }));
  write(join(output, 'validation.json'), { ...validation, episodeDigest: hash(episode), estimatedSpeechSeconds: Math.ceil(episode.sections.flatMap(s => s.turns).reduce((n, t) => n + [...t.text].length / 5.5 + 0.25, 0)), characters: episode.sections.flatMap(s => s.turns).reduce((n, t) => n + [...t.text].length, 0), turns: summary.totalTurns, audioGenerated: true, approved: false });
  const result = { audio: audioPath, durationSeconds: qa.duration, qaPassed: qa.passed, approved: false, published: false };
  log(JSON.stringify(result, null, 2));
  return result;
}
