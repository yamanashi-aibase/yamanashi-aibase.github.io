import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../../scripts/podcast/core.mjs';
import { synthesize, pcmWav, tone } from '../../scripts/podcast/audio.mjs';
import { fixture } from './fixture.mjs';

const configured = () => read(new URL('../../podcast/config.gemini.example.json', import.meta.url));
test('Gemini REST sends a separate API key header, voice, verbatim text, and accepts WAV', async () => {
  const config = configured(), turn = fixture().episode.sections[0].turns[0];
  config.tts.apiKeyEnv = 'PODCAST_GEMINI_TEST_KEY'; process.env.PODCAST_GEMINI_TEST_KEY = 'fixture-only';
  try {
    const wav = tone(turn);
    const actual = await synthesize(turn, config, async (url, options) => {
      assert.equal(url, `${config.tts.endpoint}/models/${config.tts.model}:generateContent`);
      assert(!url.includes('fixture-only')); assert.equal(options.headers['x-goog-api-key'], 'fixture-only');
      assert(!options.headers.Authorization); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.contents[0].parts[0].text, turn.text);
      assert.equal(body.generationConfig.speechConfig.voiceConfig.voice, 'Kore');
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] });
    }); assert.deepEqual(actual, wav);
  } finally { delete process.env.PODCAST_GEMINI_TEST_KEY; }
});
test('Gemini preview raw PCM is wrapped as WAV at the declared sample rate', async () => {
  const config = configured(), turn = fixture().episode.sections[0].turns[0];
  config.tts.apiKeyEnv = 'PODCAST_GEMINI_TEST_KEY'; process.env.PODCAST_GEMINI_TEST_KEY = 'fixture-only';
  config.tts.model = 'gemini-3.1-flash-tts-preview';
  try {
    const actual = await synthesize(turn, config, async (_, options) => {
      assert.equal(JSON.parse(options.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] });
    });
    assert.equal(actual.length, 524); assert.equal(actual.readUInt32LE(24), 24000);
    assert.equal(actual.toString('ascii', 0, 4), 'RIFF');
  } finally { delete process.env.PODCAST_GEMINI_TEST_KEY; }
});
test('Gemini rejects incomplete, blocked, invalid audio and untrusted credential endpoints', async () => {
  const config = configured(), turn = fixture().episode.sections[0].turns[0];
  config.tts.apiKeyEnv = 'PODCAST_GEMINI_TEST_KEY'; process.env.PODCAST_GEMINI_TEST_KEY = 'fixture-only';
  try {
    await assert.rejects(synthesize(turn, config, async () => new Response('do not print key', { status: 429 })), /HTTP 429/);
    await assert.rejects(synthesize(turn, config, async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), /did not complete/);
    await assert.rejects(synthesize(turn, config, async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } })), /did not complete/);
    await assert.rejects(synthesize(turn, config, async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/mpeg', data: 'YWJj' } }] } }] })), /Unsupported/);
    config.tts.endpoint = 'https://example.com/v1beta';
    await assert.rejects(synthesize(turn, config, () => { throw new Error('must not call fetch'); }), /official Gemini/);
    assert.throws(() => pcmWav(Buffer.alloc(3)), /Invalid/);
  } finally { delete process.env.PODCAST_GEMINI_TEST_KEY; }
});
