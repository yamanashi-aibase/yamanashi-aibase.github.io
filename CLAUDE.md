# AI BASE Website

GitHub Pages 静的サイト。AI関連ミートアップ（AI BASE）の月次まとめを掲載。

> Codex など Claude Code 以外のコーディングエージェントは `AGENTS.md` を参照。内容は同期させること。

## 自動化ワークフロー（n8n）

**ブランチ・PR・HTMLテンプレートはすべて n8n が自動生成する。絶対に削除・上書きしないこと。**

Claude の役割は、n8n が作成したブランチ上に追加コミットをすることで、自動生成されたコンテンツを補完・修正すること。

### n8n が行うこと
- Discord チャンネルデータ → `summaries/response.json` に保存
- `response.json` を元にサマリー HTML を生成 → `summaries/YYYYMMDD_HHMM.html`
- ブランチ `auto-summary-YYYY-MM-DD-HHMMSS` を作成
- PR を作成して `main` にマージ申請
- `index.html` に新しい `.summary-card` を追加

### Claude が行うこと
- 既存の `auto-summary-*` ブランチ上で追加コミットをする
- HTML の内容確認・修正（リンク切れ、フォーマット崩れ等）
- n8n の PR・ブランチには干渉しない（force push, ブランチ削除 禁止）

## generate-summary スキル（n8nを介さない代替フロー）

`scripts/generate-summary.mjs` は、n8n を使わずにこのセッション自身が Discord メッセージの分類まで担う代替ワークフロー。詳細は `.claude/commands/generate-summary.md` を参照（`/generate-summary` で起動）。

要点:
- 分類（グループ分け・headline・タグ付け）はデフォルトでこのセッション自身が行う。追加のAPI課金は発生せず、今使っているモデル・サブスクリプションで完結する
- グループ分けは固定のカテゴリ一覧ではなく、そのバッチのリンク群を見て6〜7個程度の自然なグループをその場で決める
- `ANTHROPIC_API_KEY` は任意。設定した場合のみ Anthropic API 経由の自動分類 + レビューなしでのPR作成までフォールバックできる（ライブなセッションがないヘッドレス/CI実行向け）
- 使い方（3段階、`ANTHROPIC_API_KEY` 未設定時）: `node scripts/generate-summary.mjs <channel_id> <channel_name>` で取得・前処理 → 表示された処理済みエントリを自分でグループ分け → `node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>` でHTMLを`summaries/`に生成（一旦停止）→ レビュー後 `node scripts/generate-summary.mjs publish <filename> <channel_name>` でPR作成

## ディレクトリ構成

```
index.html            # トップページ（サマリーカード一覧）
style.css             # 共通スタイル（変更は慎重に）
CNAME                 # カスタムドメイン設定（変更禁止）
img/                  # ロゴ等の画像
scripts/
  generate-summary.mjs # n8nを介さない代替の生成スクリプト（fetch/renderの2段階）
summaries/
  YYYYMMDD_HHMM.html  # 月次まとめページ（n8n または generate-summary.mjs が生成）
  response.json        # Discord チャンネルデータ（n8n または generate-summary.mjs が書き込む）
```

## HTML 構造

### summaries/YYYYMMDD_HHMM.html の基本構造
```html
<article class="summary">
  <h1>YYYY年M月まとめ - #チャンネル名</h1>
  <div id="view-tabs">...</div>
  <div id="tag-filter"></div>
  <div id="category-view">
    <section class="category">
      <h2>1. カテゴリ名</h2>
      <div class="contributor">
        <h3>投稿者：ユーザー名</h3>
        <ul>
          <li><strong>タイトル</strong><br><a href="URL">URL</a></li>
        </ul>
      </div>
    </section>
  </div>
  <div id="timeline-view"></div>
</article>
```

### index.html のサマリーカード
```html
<div class="summary-card">
  <h3>YYYY年M月</h3>
  <a href="summaries/YYYYMMDD_HHMM.html" class="btn">View Summary →</a>
</div>
```

## スタイルガイド

- アクセントカラー: `#E85876`
- フォント: システムフォント（日本語対応）
- `style.css` は全ページ共通。変更時は全ページへの影響を確認する

## DO NOT

- `CNAME` を変更しない
- `response.json` を編集しない（n8n / generate-summary.mjs の入力データ）
- n8n 生成のブランチを削除・force push しない
- `main` ブランチに直接コミットしない（PR 経由のみ）
- CSS フレームワーク・JS ライブラリを導入しない（静的サイト）
