# AI BASE Website

GitHub Pages 静的サイト。AI関連ミートアップ（AI BASE）の月次まとめを掲載。

> エージェント共通の指示書です。`CLAUDE.md` はこの `AGENTS.md` を参照するシンボリックリンクです。

## generate-summary ワークフロー

`scripts/generate-summary.mjs` でDiscordメッセージを取得し、分類・HTMLレビューを経てPRを作成します。実行するエージェントやモデルのベンダーは問いません。詳細は `.codex/prompts/generate-summary.md` または `.claude/commands/generate-summary.md` を参照。

要点:
- 分類（グループ分け・headline・タグ付け）はデフォルトでこのセッション自身が行う。追加のAPI課金は発生せず、今使っているモデル・サブスクリプションで完結する
- グループ分けは固定のカテゴリ一覧ではなく、そのバッチのリンク群を見て6〜7個程度の自然なグループをその場で決める（例:「モデルの新機能」「開発ツールの動向」）
- APIキー未設定時は、実行中のエージェントセッションのサブスクリプションで分類する。`OPENAI_API_KEY` または `ANTHROPIC_API_KEY` が設定されている場合は、そのベンダーのAPIで分類し、HTML生成・PR作成まで自動実行する（API利用料金が適用され、HTMLレビューで停止しない）。両方設定されている場合は `SUMMARY_API_PROVIDER=openai|anthropic` で選択する。`SUMMARY_API_MODEL` でモデルを変更できる。
- 公開するのは生成 HTML とトップページのカードのみ。Discord 生メッセージは一時ディレクトリに置くだけでコミットしない。URL の共有トラッキングパラメータ（`utm_*`、X の `s` / `t`）は自動で除去される
- 使い方（3段階、APIキー未設定時）:
  1. `node scripts/generate-summary.mjs <channel_id> <channel_name>` — Discord取得・前処理。グループ分けルールと次コマンドを表示して停止
  2. 表示された処理済みエントリを自分（エージェント）でグループ分けし、`node scripts/generate-summary.mjs render <processed.json> <classified.json> <channel_name>` でHTMLを `summaries/` に生成（PRはまだ作らず、ここで一旦停止）
  3. 生成されたHTMLを**必ずレビュー**し、問題なければ `node scripts/generate-summary.mjs publish <filename> <channel_name>` でブランチ作成・commit・push・PR作成まで進める

## Podcast

月次Podcastの生成・甲州弁への翻案は `.agents/skills/monthly-podcast/SKILL.md` と `podcast/README.md` を参照。共通CLIは `scripts/podcast.mjs`。再生一覧と標準語／甲州弁のRSSは `podcasts/` に生成する。各版の音声・QA・承認は独立して管理する。

## ディレクトリ構成

```
index.html            # トップページ（サマリーカード一覧）
style.css             # 共通スタイル（変更は慎重に）
CNAME                 # カスタムドメイン設定（変更禁止）
img/                  # ロゴ等の画像
scripts/
  generate-summary.mjs # 月次まとめ生成スクリプト（fetch/render/publishの3段階）
summaries/
  YYYYMMDD_HHMM.html  # 月次まとめページ（generate-summary.mjs が生成）
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
- `response.json` などの Discord 生データ（ユーザーID・ログイン名等を含む）をコミット・公開しない
- 既存ブランチの削除・force push は行わない
- `main` ブランチに直接コミットしない（PR 経由のみ）
- CSS フレームワーク・JS ライブラリを導入しない（静的サイト）
