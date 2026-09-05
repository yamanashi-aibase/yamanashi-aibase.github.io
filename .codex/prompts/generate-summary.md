# generate-summary

Discord チャンネルのメッセージから月次まとめ HTML を生成し、GitHub PR を作成します。

分類（グループ分け・headline・タグ付け）は、デフォルトではこの Codex セッション自身が行います（サブスクリプション利用、追加API課金なし）。`ANTHROPIC_API_KEY` はオプションで、セッションなしで完結させたいヘッドレス/CI実行のときだけ使う分類の代替手段です。

グループ分けは固定のカテゴリ一覧に当てはめるのではなく、**そのバッチのリンク群を見てその場で6〜7個程度の自然なグループを自分で決める**（詳しくは手順2）。HTML生成後は自動でPRまで進めず、`render` で一旦止まるので必ずレビューしてから `publish` に進むこと。

## 必要な環境変数

| 変数 | 説明 | 必須/任意 |
|------|------|----------|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン | 必須 |
| `ANTHROPIC_API_KEY` | Anthropic API キー（分類をAPIに任せ、レビューなしで一気にPRまで進めたい場合のみ） | 任意 |

## 使い方（このセッション内・デフォルト）

1. `fetch` でDiscordメッセージを取得・前処理する：

```bash
DISCORD_BOT_TOKEN=<token> node scripts/generate-summary.mjs <channel_id> <channel_name>
```

`ANTHROPIC_API_KEY` が未設定の場合、ここで処理は止まり、分類済みエントリを書き出すファイルパスとグループ分けルール・タグ一覧が標準出力に表示されます。

2. 表示された処理済みエントリ（JSON）を読み、**このバッチのリンク群全体を見渡して6〜7個程度の自然なグループを自分で決め**、各エントリを分類する。固定のカテゴリキーではなく、その回の内容に合った日本語のグループ名でよい（例:「OpenAI GPT-6 Astra関連」「Claude/Anthropicの動向」）。結果を指示されたパスに JSON 配列として書き出す：

```json
[
  { "id": "<元のメッセージID>", "category": "<このバッチ用に決めたグループ名>", "headline": "<日本語一行要約>", "tags": ["#タグ1", "#タグ2"] }
]
```

3. `render` で HTML を生成する（`fetch` の出力に表示されたコマンドをそのまま使う）。ここでは PR は作らず、`summaries/` にファイルを書き出して止まる：

```bash
node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>
```

4. **生成された HTML を必ずレビューする**（グループ分けの妥当性、リンク切れ、フォーマット崩れなど）。問題があれば分類JSONを直して手順3をやり直す。

5. 問題なければ `publish` でブランチ作成・commit・push・PR作成まで進める（`render` の出力に表示されたコマンドをそのまま使う）：

```bash
node scripts/generate-summary.mjs publish <filename> <channel_name>
```

### 引数

| 引数 | 例 | 説明 |
|------|----|------|
| `channel_id` | `1489234567890` | Discord チャンネル ID |
| `channel_name` | `朝活_202604` | チャンネル名（末尾 `YYYYMM` で年月を自動検出） |

## 処理フロー

1. **Discord 取得**（`fetch`） — Bot API でメッセージを全件取得（100件ずつページング）
2. **前処理**（`fetch`） — URL を含むメッセージのみ抽出、URL/日付(JST)/投稿者コメント/埋め込み(Xポストの投稿者名・本文)を分離し、一時ファイルに書き出す
3. **分類** — デフォルトはこのセッション（Codex）自身が、バッチ全体を見て6〜7個程度の自然なグループに分類。`ANTHROPIC_API_KEY` が設定されている場合は `fetch` が自動でAnthropic APIを呼び出し、そのまま4・5まで一気に進む（レビューなし・ヘッドレス/CI向け）
4. **HTML 生成**（`render`） — グループ別／時系列タブ切り替え、タグフィルタリング、投稿者コメント、Xポストの投稿者・本文プレビュー（折りたたみ表示）付きの完全テンプレートで生成し、`summaries/` に書き出して停止（レビューのためのチェックポイント）
5. **PR 作成**（`publish`） — `auto-summary-YYYY-MM-DD-HHmmss` ブランチを切って commit → push → PR

### Xポストの扱い

`x.com` / `twitter.com` のリンクは、Discord の埋め込みデータ（投稿者名・本文）をそのまま `x-meta` / `x-preview`（折りたたみ）として表示する。エンゲージメント指標（いいね・リポスト数等）は取得しない（X API 連携なし）。

## 出力ファイル

| ファイル | 内容 |
|----------|------|
| `summaries/YYYYMMDD_HHMM.html` | 生成されたまとめページ（`render` が書き出す。レビュー対象） |
| `summaries/response.json` | Discord 生メッセージ（デバッグ用） |
| `<tmpdir>/ai-base-summary-<channel_id>.json` | `fetch` が書き出す処理済みエントリ（分類対象・一時ファイル） |

## 手動実行（このセッション内）

ユーザーから `/generate-summary` を求められたら、以下を実行してください：

1. `DISCORD_BOT_TOKEN` と対象チャンネル ID・チャンネル名をユーザーに確認する
2. 上記「使い方」の手順1〜3を順番に実行する（手順2の分類は、固定カテゴリに拘らずバッチ内容に応じて自分でグループを決める。`ANTHROPIC_API_KEY` が設定済みなら手順3以降はスキップされ自動で進む）
3. 生成された HTML の内容を確認し、問題があれば分類をやり直すかHTMLを直接修正する
4. レビューが済んだらユーザーに確認のうえ、手順5（`publish`）を実行してPRを作成する

## 補足

このプロンプトの本体（`scripts/generate-summary.mjs`）は Claude Code の `/generate-summary`（`.claude/commands/generate-summary.md`）と共通です。プロジェクト全体のルール（n8n自動化ワークフロー、DO NOT等）は `AGENTS.md` を参照してください。
