import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, hash, https, read, write } from './core.mjs';
import { check } from './schema.mjs';

export function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (r.error) throw new Error(`${command}: ${r.error.message}`);
  assert(r.status === 0, `${command} failed: ${(r.stderr || '').slice(-3000)}`);
  return r.stdout + r.stderr;
}
export const ffmpeg = args => run(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-nostdin', ...args]);
export function probe(file) {
  return JSON.parse(run(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
}
export function segmentKey(turn, config) { return hash({ version: 1, text: turn.text, speaker: turn.speaker, tts: config.tts }); }
export function tone(turn) {
  // Offline transport fixture only. This is intentionally NOT spoken audio.
  const rate = 24000, count = Math.ceil(Math.max(1, [...turn.text].length / 5.5) * rate);
  const b = Buffer.alloc(44 + count * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) b.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * (turn.speaker === 'A' ? 330 : 440) * i / rate) * Math.min(1, i / 240, (count - i) / 240)), 44 + i * 2);
  return b;
}
export function pcmWav(pcm, sampleRate = 24000) {
  assert(Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0 && pcm.length <= 50 * 1024 * 1024, 'Invalid Gemini PCM payload');
  assert(Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000, 'Unsupported PCM sample rate');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export async function gemini(turn, config, key, fetcher) {
  const base = https(config.tts.endpoint);
  assert(base.origin === 'https://generativelanguage.googleapis.com' && /^\/v1(beta)?\/?$/.test(base.pathname) && !base.search && !base.hash, 'Gemini endpoint must be the official Gemini API v1/v1beta base URL');
  assert(/^[a-zA-Z0-9.-]+$/.test(config.tts.model), 'Invalid Gemini model ID');
  const preview = /^(gemini-2\.5|gemini-3\.1)-/.test(config.tts.model);
  const part = { text: turn.text };
  if (config.tts.style && !preview) part.speech_metadata = { style: config.tts.style };
  const voice = config.tts.voices[turn.speaker];
  const body = { contents: [{ role: 'user', parts: [part] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: preview ? { prebuiltVoiceConfig: { voiceName: voice } } : { voice } } } };
  const response = await fetcher(`${base.href.replace(/\/$/, '')}/models/${config.tts.model}:generateContent`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, `Gemini TTS HTTP ${response.status}; response body omitted to protect credentials`);
  const result = await response.json(), candidate = result.candidates?.[0];
  assert(candidate && (!candidate.finishReason || candidate.finishReason === 'STOP'), 'Gemini TTS did not complete; no audio cached');
  const blocks = candidate.content?.parts?.filter(p => p.inlineData?.data) || [];
  assert(blocks.length === 1, 'Gemini TTS must return exactly one inline audio block');
  const inline = blocks[0].inlineData;
  assert(typeof inline.data === 'string' && inline.data.length <= 70 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(inline.data), 'Invalid Gemini base64 audio');
  const audio = Buffer.from(inline.data, 'base64'), mime = String(inline.mimeType || '').toLowerCase();
  assert(audio.length > 0 && audio.length <= 50 * 1024 * 1024, 'Invalid Gemini audio size');
  if (/^audio\/(wav|x-wav)(;|$)/.test(mime)) {
    assert(audio.length > 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE', 'Invalid Gemini WAV');
    return audio;
  }
  assert(/^audio\/(l16|pcm)(;|$)/.test(mime), 'Unsupported Gemini audio format');
  const rate = Number(mime.match(/(?:^|;)\s*rate=(\d+)/)?.[1] || 24000);
  return pcmWav(audio, rate);
}
export async function synthesize(turn, config, fetcher = fetch) {
  check(config, 'config');
  if (config.tts.provider === 'mock-tone') return tone(turn);
  https(config.tts.endpoint);
  const key = process.env[config.tts.apiKeyEnv];
  assert(key, `Set ${config.tts.apiKeyEnv} (API key; subscription credentials are unsupported)`);
  if (config.tts.provider === 'gemini') return gemini(turn, config, key, fetcher);
  const response = await fetcher(config.tts.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.tts.model, voice: config.tts.voices[turn.speaker], input: turn.text, response_format: 'wav' }) });
  assert(response.ok, `TTS HTTP ${response.status}; response body omitted to protect credentials`);
  const audio = Buffer.from(await response.arrayBuffer());
  assert(audio.length > 44 && audio.length <= 50 * 1024 * 1024 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE', 'TTS must return RIFF/WAVE audio');
  return audio;
}
export async function segments(episode, config, directory, { execute = false, segment, minIntervalMs = 0, onProgress = () => {} } = {}) {
  check(config, 'config');
  assert(Number.isFinite(minIntervalMs) && minIntervalMs >= 0 && minIntervalMs <= 60000, 'Request interval must be 0–60000 milliseconds');
  assert(config.tts.voices.A !== config.tts.voices.B, 'Configure distinct TTS voices for A and B');
  const turns = episode.sections.flatMap(s => s.turns);
  if (segment) assert(turns.some(t => t.id === segment), 'Unknown segment ID');
  const pending = turns.filter(t => {
    if (segment) return t.id === segment;
    const path = join(directory, `${t.id}.json`), wav = join(directory, `${t.id}.wav`);
    if (!existsSync(path) || !existsSync(wav)) return true;
    const meta = read(path);
    return meta.key !== segmentKey(t, config) || meta.audioDigest !== hash(readFileSync(wav));
  });
  if (!execute) return { dryRun: true, provider: config.tts.provider, model: config.tts.model, segments: pending.map(t => t.id), characters: pending.reduce((n, t) => n + [...t.text].length, 0), estimatedSpeechSeconds: Math.ceil(pending.reduce((n, t) => n + [...t.text].length / 5.5 + 0.25, 0)) };
  mkdirSync(directory, { recursive: true });
  let lastStarted = 0;
  for (const [index, turn] of pending.entries()) {
    const remaining = minIntervalMs - (Date.now() - lastStarted);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    lastStarted = Date.now();
    onProgress({ phase: 'generating', id: turn.id, index: index + 1, total: pending.length });
    const audio = await synthesize(turn, config);
    const tmp = join(directory, `${turn.id}.pending.wav`);
    writeFileSync(tmp, audio);
    const info = probe(tmp);
    assert(Number(info.format.duration) > 0 && info.streams.some(s => s.codec_type === 'audio'), `Invalid TTS audio: ${turn.id}`);
    writeFileSync(join(directory, `${turn.id}.wav`), audio);
    write(join(directory, `${turn.id}.json`), { key: segmentKey(turn, config), audioDigest: hash(audio) });
    onProgress({ phase: 'complete', id: turn.id, index: index + 1, total: pending.length });
  }
  return { generated: pending.map(t => t.id), provider: config.tts.provider };
}
export function loudness(log) {
  const matches = [...log.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];
  assert(matches.length, 'FFmpeg loudness measurements missing');
  return JSON.parse(matches.at(-1)[0]);
}
export function assemble(episode, config, directory, output) {
  const entries = [], durations = {};
  for (const section of episode.sections) {
    durations[section.id] = 0;
    for (const turn of section.turns) {
      const wav = resolve(directory, `${turn.id}.wav`), meta = read(join(directory, `${turn.id}.json`));
      assert(meta.key === segmentKey(turn, config) && meta.audioDigest === hash(readFileSync(wav)), `Missing/stale/corrupt segment ${turn.id}; regenerate first`);
      const normalized = resolve(directory, `${turn.id}.pcm.wav`);
      // Every segment has the same stream parameters before concat.
      ffmpeg(['-y', '-i', wav, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', normalized]);
      durations[section.id] += Number(probe(normalized).format.duration);
      entries.push(`file '${normalized.replaceAll("'", "'\\''")}'`);
    }
    assert(durations[section.id] <= section.seconds * 1.1, `Actual audio exceeds section budget: ${section.id}`);
  }
  const list = resolve(directory, 'concat.txt');
  writeFileSync(list, entries.join('\n') + '\n');
  const measure = loudness(ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']));
  assert(Number.isFinite(Number(measure.input_i)), 'Audio is silent or invalid');
  const filter = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measure.input_i}:measured_TP=${measure.input_tp}:measured_LRA=${measure.input_lra}:measured_thresh=${measure.input_thresh}:offset=${measure.target_offset}:linear=true`;
  mkdirSync(dirnameOf(output), { recursive: true });
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-af', filter, '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', output]);
  return quality(episode, output, durations, config.tts.provider);
}
function dirnameOf(path) { return resolve(path, '..'); }
export function quality(episode, audioPath, sectionDurations, provider) {
  const info = probe(audioPath), duration = Number(info.format.duration);
  assert(Number.isFinite(duration) && duration > 0 && duration <= 1800, 'Final duration must be 0–1800 seconds');
  const stream = info.streams.find(s => s.codec_type === 'audio');
  assert(stream?.codec_name === 'mp3' && stream.sample_rate === '48000', 'Expected MP3 at 48 kHz');
  const log = ffmpeg(['-i', audioPath, '-af', 'silencedetect=noise=-45dB:d=2,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const measured = loudness(log), integrated = Number(measured.input_i), peak = Number(measured.input_tp);
  assert(Number.isFinite(integrated) && integrated >= -18 && integrated <= -14, `Loudness outside -16±2 LUFS: ${integrated}`);
  assert(Number.isFinite(peak) && peak <= -1, `Peak too high: ${peak} dBTP`);
  const silences = [...log.matchAll(/silence_duration: ([\d.]+)/g)].map(x => Number(x[1]));
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)], ends = [...log.matchAll(/silence_end: ([\d.]+)/g)];
  if (starts.length > ends.length) silences.push(duration - Number(starts.at(-1)[1]));
  assert(Math.max(0, ...silences) <= 8, 'Detected silence longer than 8 seconds');
  const audio = readFileSync(audioPath);
  return { passed: true, provider, episodeDigest: hash(episode), audioDigest: hash(audio), duration, bytes: audio.length, sectionDurations, integratedLufs: integrated, truePeakDb: peak, longestSilence: Math.max(0, ...silences) };
}
