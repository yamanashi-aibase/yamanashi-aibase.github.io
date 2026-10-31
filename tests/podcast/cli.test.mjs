import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
function cli(...args) {
  return spawnSync(process.execPath, ['scripts/podcast.mjs', ...args], { cwd: root, encoding: 'utf8' });
}
const pair = ['--inventory', 'podcast/examples/inventory.json', '--episode', 'podcast/examples/episode.json'];
test('CLI integrates processed JSON, plan validation, section briefs and safe TTS dry-run', () => {
  const out = mkdtempSync(join(tmpdir(), 'podcast-cli-'));
  const ingest = cli('ingest', '--processed', 'podcast/examples/processed.json', '--month', '2026-10', '--out', out);
  assert.equal(ingest.status, 0, ingest.stderr); assert.equal(JSON.parse(ingest.stdout).sources, 3);
  const draft = cli('validate', '--inventory', join(out, 'inventory.json'), '--episode', join(out, 'episode.json'), '--stage', 'plan');
  assert.equal(draft.status, 1); assert.match(draft.stderr, /Research required/);
  const script = cli('validate', ...pair); assert.equal(script.status, 0, script.stderr);
  const briefs = cli('briefs', ...pair, '--out', out); assert.equal(briefs.status, 0, briefs.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, 'news.json'))).stories.length, 2);
  const dry = cli('tts', ...pair, '--config', 'podcast/config.example.json', '--out', out);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(cli('tts', ...pair, '--execut').status, 1);
  const body = join(out, 'pr-body.md');
  assert.equal(cli('pr', '--body', body).status, 0);
  writeFileSync(body, 'human edited review');
  assert.equal(cli('pr', '--body', body).status, 0);
  assert.equal(readFileSync(body, 'utf8'), 'human edited review');
});

test('CLI prepares dialect briefs and validates a separate translated script without calling TTS', () => {
  const out = mkdtempSync(join(tmpdir(), 'podcast-adapt-cli-'));
  const briefs = cli('adapt-briefs', ...pair, '--variant', 'koshu', '--out', join(out, 'briefs'));
  assert.equal(briefs.status, 0, briefs.stderr);
  assert.match(JSON.parse(readFileSync(join(out, 'briefs/opening.json'))).prompt, /甲州弁/);
  const original = JSON.parse(readFileSync(resolve(root, 'podcast/examples/episode.json')));
  const translations = original.sections.flatMap(s => s.turns.map(t => ({id: t.id, text: '架空のテストの話だよ。'})));
  const input = join(out, 'translations.json'); writeFileSync(input, JSON.stringify(translations));
  const adapted = cli('adapt', ...pair, '--variant', 'koshu', '--translations', input, '--out', join(out, 'koshu'));
  assert.equal(adapted.status, 0, adapted.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, 'koshu/episode.json'))).variant, 'koshu');
  assert.equal(cli('adapt', ...pair, '--variant', 'koshu', '--translations', input, '--out', join(out, 'koshu')).status, 1);
});
