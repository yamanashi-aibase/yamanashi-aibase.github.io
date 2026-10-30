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

function fixture({ dirty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'summary-test-'));
  const calls = [];
  const context = vm.createContext({ root, process: { env: {} }, console: { log() {} }, URL, Date,
    readFileSync, writeFileSync, mkdirSync, existsSync, resolve: (...p) => join(...p),
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
