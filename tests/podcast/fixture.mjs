import { read, ingest, hash } from '../../scripts/podcast/core.mjs';
export function fixture() {
  const processed = read(new URL('../../podcast/examples/processed.json', import.meta.url));
  const config = read(new URL('../../podcast/config.example.json', import.meta.url));
  config.tts.provider = 'mock-tone';
  const { inventory, episode } = ingest(processed, '2026-10');
  episode.stories = [{ ...episode.stories[0], sourceIds: ['source-1', 'source-2'], claims: [{ id: 'claim-1', text: 'これは架空のテスト用発表です。', certainty: 'verified', evidence: [{ url: 'https://example.com/launch', excerpt: '架空のテスト用根拠。実ニュースではない。', accessedAt: '2026-10-25', kind: 'primary' }] }] }, { ...episode.stories[2], disposition: 'notes_only', reason: '一次情報を確認できないため公開ノートに残す。' }];
  episode.topics[0].storyIds = episode.stories.map(s => s.id);
  const text = 'これは架空のテスト用の会話です。';
  episode.sections.forEach((s, i) => { s.turns = [
    { id: `turn-${i}-a`, speaker: 'A', text, claimIds: i === 1 ? ['claim-1'] : [], storyIds: i === 1 ? ['story-1'] : [] },
    { id: `turn-${i}-b`, speaker: 'B', text, claimIds: i === 1 ? ['claim-1'] : [], storyIds: i === 1 ? ['story-1'] : [] }
  ]; });
  return { processed, inventory, episode, config };
}
export function fakeQa(episode, audio) {
  return { passed: true, provider: 'openai-compatible', episodeDigest: hash(episode), audioDigest: hash(audio), duration: 20, bytes: audio.length, sectionDurations: { opening: 5, news: 10, closing: 5 }, integratedLufs: -16, truePeakDb: -1.5, longestSilence: 0 };
}
