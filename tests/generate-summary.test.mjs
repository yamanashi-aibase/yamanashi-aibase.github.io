import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../scripts/generate-summary.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/const __dirname = .*;\nconst ROOT = .*;/, 'const ROOT = root;')
  .replace(/main\(\)\.catch\([\s\S]*$/, '');

function fixture({ dirty = false, env = {}, fetch: fetchMock } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'summary-test-'));
  const calls = [];
  const context = vm.createContext({ root, process: { env }, fetch: fetchMock, console: { log() {} }, URL, Date,
    readFileSync, writeFileSync, mkdirSync, existsSync, tmpdir: () => root, resolve: (...p) => join(...p),
    execFileSync(command, args) {
      calls.push([command, Array.from(args)]);
      if (dirty && args[0] === 'status') return ' M unrelated.txt';
      if (args[0] === 'show') return '<div class="summary-list">\nexisting cards';
      return '';
    } });
  vm.runInContext(source, context);
  return { root, calls, run: code => vm.runInContext(code, context) };
}

test('render validates coverage, preserves source fields, strips tracking, and refuses overwrite', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'processed.json'), JSON.stringify([{ id: '1', url: 'https://x.com/user/status/1?t=private&s=20', author: '__proto__', date: '2026/10/31', comment: '<script>bad</script>' }]));
    writeFileSync(join(f.root, 'classified.json'), JSON.stringify([{ id: '1', category: '__proto__', headline: '<headline>', tags: ['#AI'], url: 'https://evil.test', author: 'overridden' }]));
    const filename = await f.run("runRender(root + '/processed.json', root + '/classified.json', '朝活_202610')");
    const html = readFileSync(join(f.root, 'summaries', filename), 'utf8');
    assert.match(html, /https:\/\/x.com\/user\/status\/1/);
    assert.doesNotMatch(html, /private|evil.test|overridden|<script>bad/);
    assert.match(html, /&lt;headline&gt;/);
    await assert.rejects(f.run("runRender(root + '/processed.json', root + '/classified.json', '朝活_202610')"), /EEXIST/);
    writeFileSync(join(f.root, 'classified.json'), '[]');
    await assert.rejects(f.run("runRender(root + '/processed.json', root + '/classified.json', '朝活_202610')"), /exactly one/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('publish uses latest origin/main, adds a card, and never stages raw data', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'summaries'));
    writeFileSync(join(f.root, 'summaries/20261031_1234.html'), '<article>reviewed</article>');
    f.run(`publishPR('20261031_1234.html', 'name"$(exit 1)', '2026年10月')`);
    assert.deepEqual(f.calls.find(([, args]) => args[0] === 'fetch'), ['git', ['fetch', 'origin', 'main']]);
    assert.equal(f.calls.find(([, args]) => args[0] === 'checkout')[1].at(-1), 'origin/main');
    assert.deepEqual(f.calls.find(([, args]) => args[0] === 'add')[1], ['add', '--', 'summaries/20261031_1234.html', 'index.html']);
    assert.match(readFileSync(join(f.root, 'index.html'), 'utf8'), /2026年10月/);
    assert.throws(() => f.run("publishPR('../response.json', 'channel', 'month')"), /filename/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('publish stops before fetching or switching branches when tracked changes exist', () => {
  const f = fixture({ dirty: true });
  try {
    mkdirSync(join(f.root, 'summaries'));
    writeFileSync(join(f.root, 'summaries/20261031_1234.html'), '<article>reviewed</article>');
    assert.throws(() => f.run("publishPR('20261031_1234.html', 'channel', 'month')"), /Commit or stash/);
    assert.equal(f.calls.length, 1);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('classification defaults to session; keys select a provider and dual keys require a choice', () => {
  const f = fixture();
  try {
    assert.equal(f.run('classificationConfig({})'), null);
    assert.equal(f.run("classificationConfig({OPENAI_API_KEY: 'openai-test'}).provider"), 'openai');
    assert.equal(f.run("classificationConfig({ANTHROPIC_API_KEY: 'anthropic-test'}).provider"), 'anthropic');
    assert.throws(() => f.run("classificationConfig({OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b'})"), /Both API keys/);
    assert.equal(f.run("classificationConfig({OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', SUMMARY_API_PROVIDER: 'anthropic', SUMMARY_API_MODEL: 'custom-model'}).model"), 'custom-model');
    assert.throws(() => f.run("classificationConfig({SUMMARY_API_PROVIDER: 'openai'})"), /key is not set/);
    assert.throws(() => f.run("classificationConfig({SUMMARY_API_PROVIDER: 'invalid'})"), /must be/);
  } finally { rmSync(f.root, { recursive: true }); }
});

for (const provider of ['openai', 'anthropic']) {
  test(`${provider}: request authentication, model and response parsing`, async () => {
    let request;
    const result = [{ id: '1', category: 'モデル', headline: 'ニュース', tags: ['#AI'] }];
    const response = provider === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }
      : { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'ignored' }, { type: 'text', text: '```json\n' + JSON.stringify(result) + '\n```' }] };
    const f = fixture({ fetch: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => response }; } });
    try {
      const actual = await f.run(`categorizeMessages([{ id: '1', url: 'https://example.com' }], { provider: '${provider}', key: 'test-key', model: 'test-model' })`);
      assert.equal(JSON.stringify(actual), JSON.stringify(result));
      assert.equal(JSON.parse(request.body).model, 'test-model');
      if (provider === 'openai') {
        assert.equal(request.url, 'https://api.openai.com/v1/responses');
        assert.equal(request.headers.Authorization, 'Bearer test-key');
        assert.equal(JSON.parse(request.body).store, false);
      } else {
        assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(request.headers['x-api-key'], 'test-key');
      }
    } finally { rmSync(f.root, { recursive: true }); }
  });

  test(`${provider}: API errors and truncated responses stop the flow`, async () => {
    let response = { ok: false, status: 401 };
    const f = fixture({ fetch: async () => response });
    const command = `categorizeMessages([{id: '1'}], {provider: '${provider}', key: 'secret-key', model: 'test-model'})`;
    try {
      await assert.rejects(f.run(command), /API error 401/);
      response = { ok: true, json: async () => ({ status: 'incomplete', stop_reason: 'max_tokens' }) };
      await assert.rejects(f.run(command), /did not complete/);
      response = { ok: true, json: async () => ({ status: 'completed', stop_reason: 'end_turn', content: [], output: [] }) };
      await assert.rejects(f.run(command), /expected a JSON array/);
    } finally { rmSync(f.root, { recursive: true }); }
  });
}

for (const provider of [null, 'openai', 'anthropic']) {
  test(`fetch flow: ${provider ?? 'session default'}`, async () => {
    const env = { DISCORD_BOT_TOKEN: 'discord-test' };
    if (provider) env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] = 'test-key';
    const calls = [];
    const classified = JSON.stringify([{ id: '1', category: 'モデル', headline: 'ニュース', tags: ['#AI'] }]);
    const f = fixture({ env, fetch: async url => {
      calls.push(url);
      return { ok: true, json: async () => url.includes('discord.com')
        ? [{ id: '1', content: 'https://example.com', timestamp: '2026-10-30T00:00:00Z', author: { global_name: '投稿者' } }]
        : provider === 'openai'
          ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: classified }] }] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: classified }] }
      };
    } });
    try {
      f.run('var published = null; runPublish = async (filename, channel) => { published = { filename, channel }; };');
      await f.run("runFetch('123', '朝活_202610')");
      assert.equal(calls.length, provider ? 2 : 1);
      assert.equal(existsSync(join(f.root, 'ai-base-summary-123.json')), true);
      assert.equal(existsSync(join(f.root, 'summaries')), Boolean(provider));
      assert.equal(f.run('published !== null'), Boolean(provider));
    } finally { rmSync(f.root, { recursive: true }); }
  });
}
