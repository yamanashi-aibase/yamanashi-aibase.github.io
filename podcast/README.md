# AI BASE Podcast

月次まとめと独立したPodcast生成・再生機能です。日本語の2人対話、1回30分以内。台本は実行中のエージェントセッションで作成し、音声だけTTS APIで生成します。

## ページとRSS

- `podcasts/index.html`: 全月を新しい順に並べ、年見出し・月への移動メニューを表示。
- 月ごとに1枚のカード。標準語／甲州弁を切り替えて再生。未公開の版は再生できません。
- 同時再生の防止、速度変更、15秒送り／戻し、チャプター、文字起こし、出典。
- チャプター・文字起こし・出典は折りたたみ。音声は `preload="none"` で、過去月が増えても全音声を先読みしません。
- `podcasts/feed.xml`: 標準語RSS。`podcasts/feed-koshu.xml`: 甲州弁RSS。
- 各RSSは該当版だけを収録し、固定GUID・外部MP3のURL/実バイト数・再生時間・公開確認日を出力します。
- 標準語の既存URL・GUIDは維持。甲州弁は `YYYY-MM-koshu` を識別子に使います。
- 公開データは `podcasts/episodes/YYYY-MM.json` と `YYYY-MM-koshu.json`。`variant` がない既存データは標準語として扱います。

公開済みデータがない段階では空の一覧とRSSを生成します。テスト用の架空エピソードや未承認MP3は公開しません。

## 環境

Node.js 22以上、音声処理には `ffmpeg` / `ffprobe` が必要です。`FFMPEG` / `FFPROBE` で実行ファイルを指定できます。npm依存はありません。

作業データ・認証情報・音声はGit対象外の `work/` に置きます。TTSキーは環境変数か `--key-file` で指定し、コミットしません。既存generate-summaryの処理済みJSONを使うため、Discordの再取得は不要です。

入口:

- 共通スキル: `.agents/skills/monthly-podcast/SKILL.md`
- Codex: `.codex/prompts/generate-podcast.md`
- Claude Code: `.claude/commands/generate-podcast.md` / `.claude/skills/monthly-podcast`

## 標準語版を準備

```bash
node scripts/podcast.mjs ingest --processed /path/to/processed.json \
  --month 2026-10 --out work/podcast/2026-10/standard
```

任意で `--classified /path/to/classified.json`。`inventory.json` は入力のURL・見出し・日付だけを残した在庫、`episode.json` は未調査の雛形です。Discord ID・投稿者・コメント・本文は在庫へコピーしません。元入力の取得範囲（最初のURL抽出・重複除去後）をcoverageの母集団とします。

セッションで全SourceをStoryへ、StoryをTopicへ、Topicをsectionへ割り当てます。Storyのclaimへ根拠・確認日・確度を記録。一次情報で確認できた場合は `verified`、未検証の報道・投稿は `reported` とし、発話でも留保を維持します。話さない話題は `notes_only` と省略理由を記録します。

```bash
node scripts/podcast.mjs validate --inventory work/podcast/2026-10/standard/inventory.json \
  --episode work/podcast/2026-10/standard/episode.json --stage plan
node scripts/podcast.mjs briefs --inventory work/podcast/2026-10/standard/inventory.json \
  --episode work/podcast/2026-10/standard/episode.json --out work/podcast/2026-10/standard/briefs
```

各briefを実行中のセッションで読み、sectionごとの対話を作って `turns` へ戻します。発言の `id / speaker / text / claimIds / storyIds` を維持します。29分の台本予算と1分の音声変動分を確保します。

## 甲州弁版を準備

標準語版の調査済み台本から発話文だけを変えます。根拠・話題構成・発言ID・話者・参照はCLIが維持します。軽めで聞き取りやすい甲州弁を基本とし、専門語・数字・断定の強さを変えません。一律の語尾置換はしません。

```bash
node scripts/podcast.mjs adapt-briefs \
  --inventory work/podcast/2026-10/standard/inventory.json \
  --episode work/podcast/2026-10/standard/episode.json \
  --variant koshu --out work/podcast/2026-10/koshu-briefs
```

セッションで各briefの発言を言い換え、全section分を `[{"id":"元の発言ID","text":"甲州弁の発話文"}]` の1配列として `work/podcast/2026-10/koshu-translations.json` へ保存します。

```bash
node scripts/podcast.mjs adapt \
  --inventory work/podcast/2026-10/standard/inventory.json \
  --episode work/podcast/2026-10/standard/episode.json \
  --variant koshu --translations work/podcast/2026-10/koshu-translations.json \
  --out work/podcast/2026-10/koshu
```

全発言が一度ずつ含まれること、参照と時間予算を検証します。既存版の上書きは拒否します。意味・方言の自然さは地元話者のレビューで確認します。県内でも地域差・世代差があり、「ずら」は文脈に合う推量などに使います。[山梨県の方言資料](https://www.pref.yamanashi.jp/kids/kyusekki.html)を参照。

元の標準語版を後から修正しても甲州弁版は自動更新しません。`adaptedFrom` に元台本のハッシュを記録しているため、最新標準語版の `hash(episode)` と比較してから再翻案してください。

## 各版のTTS・品質検証

`podcast/config.gemini.example.json`（標準語）または `podcast/config.gemini.koshu.example.json`（甲州弁）を各作業ディレクトリの `config.json` にコピーします。同じモデル・話者でも、台本とTTS styleでキャッシュが分かれます。モデル・voiceは利用可能なものに変更できます。

GeminiはGoogle AI Studio / Gemini APIキーを `GEMINI_API_KEY` へ設定。OpenAI互換形式は `podcast/config.example.json` を使い、HTTPS POST `{model,voice,input,response_format:"wav"}` に対応するTTS endpointを設定します。サブスクリプションのログイン情報は音声APIへ転用しません。

以下は甲州弁版の例です。標準語版はパスを `standard` に置き換えます。

```bash
node scripts/podcast.mjs tts --inventory work/podcast/2026-10/koshu/inventory.json \
  --episode work/podcast/2026-10/koshu/episode.json \
  --config work/podcast/2026-10/koshu/config.json --out work/podcast/2026-10/koshu/segments
```

初回はdry-run。課金のある合成を実行する際は `--execute`、1発言だけなら `--segment turn-id`、キーファイルを使う場合は `--key-file /path/to/key` を追加します。版ごとに別のsegmentsディレクトリを使います。

```bash
node scripts/podcast.mjs assemble --inventory work/podcast/2026-10/koshu/inventory.json \
  --episode work/podcast/2026-10/koshu/episode.json --config work/podcast/2026-10/koshu/config.json \
  --segments work/podcast/2026-10/koshu/segments \
  --audio work/podcast/2026-10/koshu/episode.mp3 --qa work/podcast/2026-10/koshu/qa.json
```

WAVを48kHz monoへ揃え、2パスのloudnormとMP3変換を行います。完成音声は30分以内、-16±2 LUFS、ピーク-1 dBTP以下、8秒超の無音なし、各section予算の110%以内を検証します。内容・発音は試聴で確認します。

同じ `inventory / episode / config / audio / qa` 引数に、`player --out .../player` を使うと新デザインのローカルプレーヤーを作れます。`review --out .../review` は承認用の音声・台本・出典・承認テンプレートを準備します。

## 承認・配信・RSS更新

標準語／甲州弁は別々に試聴・承認します。人間が `approval-template.json` のreviewer・reviewedAtを入力し、listened / factsChecked / approvedをtrueにして `approval.json` として保存します。承認は台本・音声・公開情報の各ハッシュに結び付くため、再生成後は再承認が必要です。エージェントは人間の代わりに承認しません。

`upload` は上記の `inventory / episode / config / audio / qa` と `--approval` を受け取り、S3互換ストレージへの操作をdry-runで示します。明示的に配信を許可した後だけ `--execute` を追加します。配信先はHTTPS、Content-Type `audio/mpeg`、正しいContent-LengthとRange（206）対応が必要です。ストレージの作成は行いません。

`release` に同じ引数を渡すと、承認済み公開JSON・一覧・両RSSをローカル生成します。1か月×1版の二重登録は拒否します。訂正は明示的な公開JSON編集と再承認が必要です。

```bash
node scripts/podcast.mjs site
node scripts/podcast.mjs site --check
node --test tests/podcast/*.test.mjs tests/generate-summary.test.mjs
node scripts/podcast.mjs pr --body work/podcast/pr-body.md
```

PRヘルパーはdry-runが基本です。`codex/podcast*` または `podcast/*` ブランチへ変更をコミットし、pushとdraft PRを許可された場合に `--title "Podcast更新" --execute` を付けます。自動マージしません。

公開JSON・HTML・RSSだけを配信し、inventory・生メッセージ・認証情報・音声はGitに含めません。GitHubの必須レビュー設定は管理者が設定してください。

## テスト

`podcast/examples/` は架空データです。`mock-tone` は読み上げではなく、音声処理を検証するテスト音です。mock音声の公開は拒否します。FFmpegなしでは音声統合テストをskipします。CIはFFmpeg込みでテストし、ページ・RSSの再現性を検証します。有料API・upload・deployは実行しません。
