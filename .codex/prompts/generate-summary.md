# generate-summary

Discord チャンネルのメッセージから月次まとめ HTML を生成し、GitHub PR を作成します。

分類（カテゴリ・headline・タグ付け）は、デフォルトではこの Codex セッション自身が行います（今使っているモデル・サブスクリプション利用、追加API課金なし）。`ANTHROPIC_API_KEY` はオプションで、ライブなセッションなしで完結させたいヘッドレス/CI実行のときだけ使う分類の代替手段です。

## 必要な環境変数

| 変数 | 説明 | 必須/任意 |
|------|------|----------|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン | 必須 |
| `ANTHROPIC_API_KEY` | Anthropic API キー（分類をAPIに任せたい場合のみ） | 任意 |

## 使い方（このセッション内・デフォルト）

1. `fetch` でDiscordメッセージを取得・前処理する：

```bash
DISCORD_BOT_TOKEN=<token> node scripts/generate-summary.mjs <channel_id> <channel_name>
```

`ANTHROPIC_API_KEY` が未設定の場合、ここで処理は止まり、分類済みエントリを書き出すファイルパスと分類ルール（カテゴリキー・タグ一覧）が標準出力に表示されます。

2. 表示された処理済みエントリ（JSON）を読み、各エントリを分類ルールに従って自分自身（Codex）で分類する。結果を指示されたパスに JSON 配列として書き出す：

```json
[
  { "id": "<元のメッセージID>", "category": "<カテゴリキー>", "headline": "<日本語一行要約>", "tags": ["#タグ1", "#タグ2"] }
]
```

3. `render` で HTML 生成・PR 作成まで進める（`fetch` の出力に表示されたコマンドをそのまま使う）：

```bash
node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>
```

### 引数

| 引数 | 例 | 説明 |
|------|----|------|
| `channel_id` | `1489234567890` | Discord チャンネル ID |
| `channel_name` | `朝活_202604` | チャンネル名（末尾 `YYYYMM` で年月を自動検出） |

## 処理フロー

1. **Discord 取得**（`fetch`） — Bot API でメッセージを全件取得（100件ずつページング）
2. **前処理**（`fetch`） — URL を含むメッセージのみ抽出、URL/日付(JST)/投稿者コメント/埋め込み(Xポストの投稿者名・本文)を分離し、一時ファイルに書き出す
3. **分類** — デフォルトはこのセッション（Codex）自身が処理済みエントリを読んで分類。`ANTHROPIC_API_KEY` が設定されている場合は `fetch` が自動でAnthropic APIを呼び出し、そのまま4以降まで一気に進む
4. **HTML 生成**（`render`） — カテゴリ別／時系列タブ切り替え、タグフィルタリング、投稿者コメント、Xポストの投稿者・本文プレビュー（折りたたみ表示）付きの完全テンプレートで生成
5. **PR 作成**（`render`） — `auto-summary-YYYY-MM-DD-HHmmss` ブランチを切って commit → push → PR

### Xポストの扱い

`x.com` / `twitter.com` のリンクは、Discord の埋め込みデータ（投稿者名・本文）をそのまま `x-meta` / `x-preview`（折りたたみ）として表示する。エンゲージメント指標（いいね・リポスト数等）は取得しない（X API 連携なし）。

## 出力ファイル

| ファイル | 内容 |
|----------|------|
| `summaries/YYYYMMDD_HHMM.html` | 生成されたまとめページ |
| `summaries/response.json` | Discord 生メッセージ（デバッグ用） |
| `<tmpdir>/ai-base-summary-<channel_id>.json` | `fetch` が書き出す処理済みエントリ（分類対象・一時ファイル） |

## 手動実行（このセッション内）

ユーザーから `/generate-summary` を求められたら、以下を実行してください：

1. `DISCORD_BOT_TOKEN` と対象チャンネル ID・チャンネル名をユーザーに確認する
2. 上記「使い方」の手順1〜3を順番に実行する（手順2の分類は自分で行う。`ANTHROPIC_API_KEY` が設定済みならスキップされ自動で進む）
3. 生成された HTML の内容を確認し、問題があれば修正してから PR を作成する

## 補足

このプロンプトの本体（`scripts/generate-summary.mjs`）は Claude Code の `/generate-summary`（`.claude/commands/generate-summary.md`）と共通です。プロジェクト全体のルール（n8n自動化ワークフロー、DO NOT等）は `AGENTS.md` を参照してください。
