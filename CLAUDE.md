# AI BASE Website

GitHub Pages 静的サイト。AI関連ミートアップ（AI BASE）の月次まとめを掲載。

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

## ディレクトリ構成

```
index.html            # トップページ（サマリーカード一覧）
style.css             # 共通スタイル（変更は慎重に）
CNAME                 # カスタムドメイン設定（変更禁止）
img/                  # ロゴ等の画像
summaries/
  YYYYMMDD_HHMM.html  # 月次まとめページ（n8n 生成）
  response.json        # Discord チャンネルデータ（n8n が書き込む）
```

## HTML 構造

### summaries/YYYYMMDD_HHMM.html の基本構造
```html
<article class="summary">
  <h1>YYYY年M月まとめ - #チャンネル名</h1>
  <section class="category">
    <h2>1. カテゴリ名</h2>
    <div class="contributor">
      <h3>投稿者：ユーザー名</h3>
      <ul>
        <li><strong>タイトル</strong><br><a href="URL">URL</a></li>
      </ul>
    </div>
  </section>
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
- `response.json` を編集しない（n8n の入力データ）
- n8n 生成のブランチを削除・force push しない
- `main` ブランチに直接コミットしない（PR 経由のみ）
- CSS フレームワーク・JS ライブラリを導入しない（静的サイト）
