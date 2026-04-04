# generate-summary

Discord チャンネルのメッセージから月次まとめ HTML を生成し、GitHub PR を作成します。

## 必要な環境変数

| 変数 | 説明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン |
| `ANTHROPIC_API_KEY` | Anthropic API キー |

## 使い方

```bash
DISCORD_BOT_TOKEN=<token> ANTHROPIC_API_KEY=<key> \
  node scripts/generate-summary.mjs <channel_id> <channel_name>
```

### 引数

| 引数 | 例 | 説明 |
|------|----|------|
| `channel_id` | `1489234567890` | Discord チャンネル ID |
| `channel_name` | `朝活_202604` | チャンネル名（末尾 `YYYYMM` で年月を自動検出） |

## 処理フロー

1. **Discord 取得** — Bot API でメッセージを全件取得（100件ずつページング）
2. **前処理** — URL を含むメッセージのみ抽出、URL/日付(JST)/投稿者コメントを分離
3. **Claude 分類** — 20件ずつバッチで Claude にカテゴリ・headline・タグを生成させる
4. **HTML 生成** — タグフィルタリング・投稿者コメント付きの完全テンプレートで生成
5. **PR 作成** — `auto-summary-YYYY-MM-DD-HHmmss` ブランチを切って commit → push → PR

## 出力ファイル

| ファイル | 内容 |
|----------|------|
| `summaries/YYYYMMDD_HHMM.html` | 生成されたまとめページ |
| `summaries/response.json` | Discord 生メッセージ（デバッグ用） |

## 手動実行（このセッション内）

ユーザーから `/generate-summary` を求められたら、以下を実行してください：

1. `DISCORD_BOT_TOKEN` と対象チャンネル ID をユーザーに確認する
2. 次のコマンドを実行する：

```bash
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  node scripts/generate-summary.mjs <channel_id> <channel_name>
```

3. 生成された HTML の内容を確認し、問題があれば修正してから PR を作成する
