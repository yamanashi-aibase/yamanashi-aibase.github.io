#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { ingest, validate, briefs, read, write, hash, assert, https } from './podcast/core.mjs';
import { check } from './podcast/schema.mjs';
import { segments, assemble, run } from './podcast/audio.mjs';
import { release, approve, destination, saveRelease, renderSite, episodeHtml } from './podcast/site.mjs';
import { catalogHtml } from './podcast/catalog.mjs';
import { adapt, adaptationBriefs, recordId } from './podcast/variants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    assert(args[i].startsWith('--'), `Expected an option: ${args[i]}`);
    const key = args[i].slice(2);
    assert(!(key in options), `Duplicate option: ${key}`);
    if (['execute', 'check'].includes(key)) options[key] = true;
    else { assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value: ${key}`); options[key] = args[++i]; }
  }
  return options;
}
export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === 'help') {
    console.log('Podcast MVP: ingest | adapt-briefs | adapt | validate | briefs | tts | assemble | review | player | upload | release | site | pr\nSee podcast/README.md for options. Network writes require --execute.'); return;
  }
  const o = parse(rest), need = k => { assert(o[k], `--${k} is required`); return o[k]; };
  const pairOptions = ['inventory', 'episode'];
  const audioOptions = [...pairOptions, 'config', 'audio', 'qa'];
  const allowed = {
    ingest: ['processed', 'classified', 'month', 'out'],
    adapt: [...pairOptions, 'variant', 'translations', 'out'],
    'adapt-briefs': [...pairOptions, 'variant', 'out'],
    validate: [...pairOptions, 'stage'], briefs: [...pairOptions, 'out'],
    tts: [...pairOptions, 'config', 'out', 'execute', 'segment', 'key-file'],
    assemble: [...audioOptions, 'segments'], review: [...audioOptions, 'out'], player: [...audioOptions, 'out'],
    upload: [...audioOptions, 'approval', 'execute'], release: [...audioOptions, 'approval'],
    site: ['check'], pr: ['body', 'title', 'execute']
  };
  assert(allowed[command], `Unknown command ${command}`);
  Object.keys(o).forEach(k => assert(allowed[command].includes(k), `Unknown option for ${command}: --${k}`));
  const pair = () => [read(need('inventory')), read(need('episode'))];
  let result;
  if (command === 'ingest') {
    const data = ingest(read(need('processed')), need('month'), o.classified ? read(o.classified) : []);
    const dir = need('out'); write(join(dir, 'inventory.json'), data.inventory); write(join(dir, 'episode.json'), data.episode);
    result = { sources: data.inventory.sources.length, out: dir, next: 'Merge Stories/Topics, research evidence, then validate --stage plan' };
  } else if (command === 'adapt-briefs') {
    const data = adaptationBriefs(...pair(), need('variant'));
    for (const brief of data) write(join(need('out'), `${brief.sectionId}.json`), brief);
    result = { sections: data.map(b => b.sectionId), next: 'Adapt each section in this session; merge the {id,text} arrays, then run adapt' };
  } else if (command === 'adapt') {
    const [inventory, episode] = pair();
    const adapted = adapt(inventory, episode, need('variant'), read(need('translations')));
    const out = need('out');
    assert(resolve(out) !== resolve(o.episode, '..'), 'Use a separate directory for the adapted version');
    assert(!existsSync(join(out, 'episode.json')), 'Adapted episode already exists; edit it explicitly');
    write(join(out, 'inventory.json'), inventory); write(join(out, 'episode.json'), adapted);
    result = { variant: adapted.variant, out, next: 'Review the adapted dialogue, then tts/assemble/review using a separate cache and audio' };
  } else if (command === 'validate') result = validate(...pair(), o.stage || 'script');
  else if (command === 'briefs') {
    const data = briefs(...pair()); for (const b of data) write(join(need('out'), `${b.sectionId}.json`), b);
    result = { sections: data.map(x => x.sectionId) };
  } else if (command === 'tts') {
    const [inventory, episode] = pair(); validate(inventory, episode);
    const config = read(need('config')); check(config, 'config');
    if (o.execute) { run(process.env.FFMPEG || 'ffmpeg', ['-version']); run(process.env.FFPROBE || 'ffprobe', ['-version']); }
    if (o.execute && o['key-file']) {
      const key = readFileSync(o['key-file'], 'utf8').trim();
      assert(key && !/\s/.test(key), 'Key file must contain one API key only');
      process.env[config.tts.apiKeyEnv] = key;
    }
    result = await segments(episode, config, need('out'), { execute: !!o.execute, segment: o.segment });
  } else if (command === 'assemble') {
    const [inventory, episode] = pair(); validate(inventory, episode); const config = read(need('config')); check(config, 'config');
    result = assemble(episode, config, need('segments'), need('audio')); write(need('qa'), result);
  } else if (command === 'review' || command === 'release' || command === 'upload' || command === 'player') {
    const [inventory, episode] = pair(), config = read(need('config')), qa = read(need('qa')), audio = readFileSync(need('audio'));
    const record = release(inventory, episode, qa, config, audio);
    if (command === 'player') {
      const out = need('out'); mkdirSync(out, { recursive: true });
      if (resolve(o.audio) !== resolve(out, 'episode.mp3')) writeFileSync(join(out, 'episode.mp3'), audio);
      writeFileSync(join(out, 'index.html'), catalogHtml([record], { preview: true, audioByMonth: { [recordId(record)]: 'episode.mp3' } }));
      result = { page: resolve(out, 'index.html'), durationSeconds: qa.duration, published: false };
    } else if (command === 'review') {
      mkdirSync(need('out'), { recursive: true });
      write(join(o.out, 'release.json'), record);
      writeFileSync(join(o.out, 'episode.mp3'), audio);
      writeFileSync(join(o.out, 'preview.html'), episodeHtml(record, { preview: true }));
      write(join(o.out, 'approval-template.json'), { episodeDigest: record.episodeDigest, audioDigest: record.audioDigest, releaseDigest: hash(record), reviewer: '', reviewedAt: '', listened: false, factsChecked: false, approved: false });
      result = { releaseDigest: hash(record), out: o.out, next: 'Human: listen, check evidence, complete approval-template.json; upload and PR only after authorization' };
    } else {
      const approved = approve(record, read(need('approval')));
      if (command === 'release') result = saveRelease(ROOT, approved);
      else {
        const target = destination(episode, qa, config);
        https(config.storage.endpoint);
        const awsArgs = ['s3', 'cp', resolve(o.audio), `s3://${config.storage.bucket}/${target.key}`, '--endpoint-url', config.storage.endpoint, '--content-type', 'audio/mpeg', '--cache-control', 'public,max-age=31536000,immutable'];
        if (o.execute) run('aws', awsArgs);
        result = { dryRun: !o.execute, publicUrl: target.url, key: target.key };
      }
    }
  } else if (command === 'site') result = renderSite(ROOT, { checkOnly: !!o.check });
  else if (command === 'pr') {
    renderSite(ROOT, { checkOnly: true });
    const body = '## 月次Podcast\n\n- [ ] 人間が完成MP3を通して試聴した\n- [ ] 根拠・未検証表現・coverage・省略理由を確認した\n- [ ] 外部MP3のContent-Type/長さ/Range/CORSを確認した\n- [ ] 承認JSONが今回の台本・音声・公開情報に一致する\n- [ ] 人間の承認レビュー後に手動マージする（自動マージ禁止）\n';
    const path = resolve(need('body')); mkdirSync(resolve(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, body);
    if (o.execute) {
      const title = need('title'), gitOptions = { cwd: ROOT };
      run('gh', ['--version']);
      const branch = run('git', ['branch', '--show-current'], gitOptions).trim();
      assert((branch.startsWith('podcast/') || branch.startsWith('codex/podcast')), 'PR helper requires a codex/podcast* or podcast/* branch');
      assert(!run('git', ['status', '--porcelain'], gitOptions).trim(), 'Commit reviewed changes first; PR helper requires a clean tree');
      // Explicitly authorized remote operations only. No commits or merge here.
      run('git', ['push', '-u', 'origin', branch], gitOptions);
      result = { url: run('gh', ['pr', 'create', '--draft', '--base', 'main', '--title', title, '--body-file', path], gitOptions).trim() };
    } else result = { dryRun: true, body: path, next: 'Review diff; commit on podcast/*; explicitly authorize --execute to push and create a draft PR' };
  } else throw new Error(`Unknown command ${command}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(`Podcast: ${error.message}`); process.exitCode = 1; });
