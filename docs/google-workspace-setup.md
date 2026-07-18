# Google Workspace 連携セットアップガイド

xangi から Google カレンダー / Drive / Docs / Gmail を操作するための OAuth 設定手順。`xangi-cmd google_*` コマンドおよび Local LLM ツール（`gcal_*` / `gdrive_*` / `gdocs_*` / `gmail_*`）が対象。

外部 SDK には依存せず、素の REST API を直叩きする実装（`src/cli/google-api.ts`）になっている。

## 1. GCP プロジェクト作成 & API 有効化

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、新規プロジェクトを作成（または既存プロジェクトを選択）
2. 「APIとサービス」→「ライブラリ」から以下を検索し、それぞれ **有効化**:
   - Google Calendar API
   - Google Drive API
   - Google Docs API
   - Gmail API

## 2. OAuth 同意画面の設定

1. 「APIとサービス」→「OAuth 同意画面」
2. User Type は **External** を選択（個人 Google アカウントで使う想定）
3. アプリ名・サポートメールなど必須項目を入力して保存

### ⚠️ 最重要: 公開ステータスを「本番環境」にする

OAuth 同意画面のステータスが **「テスト中」のままだと、発行された refresh token が 7日で失効する**。7日おきに再認可が必要になり、xangi の常駐運用が成立しない。

「OAuth 同意画面」の「公開ステータス」で **「本番環境に公開」** を実行すること。個人利用（テストユーザーが自分のGoogleアカウントのみ）の範囲であれば、Google による審査（verification）は基本的に不要（機微スコープを使わない限り）。審査が求められた場合は、スコープを必要最小限に絞った上で自己利用であることを明記して申請する。

## 3. OAuth クライアントの作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
2. アプリケーションの種類は **「デスクトップアプリ」** を選択
3. 名前を入力して作成
4. 表示された **クライアントID** と **クライアントシークレット** を控える

## 4. refresh token の取得（`bin/google-auth-setup.mjs`）

同梱スクリプトが、localhost 上の一時 HTTP サーバーで OAuth コールバックを受け、認可コードを refresh token に交換する。追加の依存パッケージは不要（Node 標準の `http` / `fetch` のみ）。

```bash
GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=xxx \
node bin/google-auth-setup.mjs
```

1. スクリプトが表示する認可URLをブラウザで開く
2. Google アカウントで同意（要求されるスコープ: Calendar / Drive / Docs 編集、Gmail 読み取り + 下書き作成）
3. 同意後、スクリプトが自動でコールバックを受け取り、ターミナルに以下が表示される:

```
========================================
refresh token の取得に成功しました。
以下を .env に追記してください:
----------------------------------------
GOOGLE_OAUTH_REFRESH_TOKEN=<取得したrefresh token>
========================================
```

> 既に同意済みのアカウントで再実行すると `refresh_token` が返却されないことがある。その場合は [Googleアカウントの権限管理ページ](https://myaccount.google.com/permissions) で該当アプリのアクセスを一度削除してから再実行する（スクリプトは `prompt=consent` を指定して都度同意を強制するが、それでも省略される場合の対処）。

## 5. `.env` への設定

```bash
GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=xxx
GOOGLE_OAUTH_REFRESH_TOKEN=xxx

# Optional: 操作対象カレンダーID（default: primary = 自分のメインカレンダー）
# GOOGLE_CALENDAR_ID=primary
```

## 6. 使えるコマンド一覧

`xangi-cmd` の直接コマンドと、Local LLM バックエンドから呼べるツールの対応表。

| `xangi-cmd` コマンド | Local LLM ツール名 | 機能 |
| --- | --- | --- |
| `google_calendar_list` | `gcal_list_events` | 予定一覧取得 |
| `google_calendar_create` | `gcal_create_event` | 予定作成（終了時刻省略時は開始から60分） |
| `google_calendar_update` | `gcal_update_event` | 予定の更新 |
| `google_calendar_delete` | `gcal_delete_event` | 予定の削除（明示指示時のみ使うこと） |
| `google_drive_search` | `gdrive_search` | ファイル名 / 全文検索（最大10件） |
| `google_drive_read` | `gdrive_read` | ファイル内容取得（Google Docs・テキスト系のみ、バイナリ不可） |
| `google_docs_create` | `gdocs_create` | ドキュメント新規作成 |
| `google_docs_read` | `gdocs_read` | ドキュメント読み取り |
| `google_docs_append` | `gdocs_append` | ドキュメント末尾への追記 |
| `google_gmail_search` | `gmail_search` | メール検索（Gmail検索構文使用可、最大10件） |
| `google_gmail_read` | `gmail_read` | メール本文読み取り |
| `google_gmail_draft` | `gmail_draft` | メール下書き作成（**送信はしない**） |

`xangi-cmd` からの直接実行例:

```bash
node dist/cli/xangi-cmd.js google_calendar_list --time-min 2026-07-18T00:00:00+09:00 --max-results 5
node dist/cli/xangi-cmd.js google_calendar_create --summary "会議" --start 2026-07-20T15:00:00+09:00
node dist/cli/xangi-cmd.js google_gmail_search --query "from:example.com 予算"
```

## 7. 安全ポリシー

- **Gmail は下書きまで**。`gmail_draft` / `google_gmail_draft` は Gmail API の drafts エンドポイントを叩くのみで、送信用の API 呼び出しはコード上に存在しない（送信ツール自体が未実装）。
- **削除操作（カレンダー予定削除）はユーザーの明示指示時のみ**実行する。一覧・要約からAIが自発的に削除を判断してはならない。
- **`.env` は絶対にコミットしない**。`GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` はいずれも漏洩するとカレンダー・Drive・Docs・Gmail への実アクセス権を与えてしまう。`.gitignore` で `.env` は既に除外済みだが、誤って `.env.local` 等の別名で作成した場合も同様に扱うこと。
- refresh token が失効した場合（同意画面が「テスト中」のまま7日経過、またはユーザーが手動でアクセスを取り消した場合）は、手順4を再実行して再取得する。
