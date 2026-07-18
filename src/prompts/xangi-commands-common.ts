/**
 * 全プラットフォーム共通のxangiコマンド（Discord/Slack/Web）
 */
export const XANGI_COMMANDS_COMMON = `## Google Workspace 連携

\`xangi-cmd google_*\` で Google カレンダー / Drive / Docs / Gmail を操作できる（要 OAuth 設定）。

- カレンダー: \`google_calendar_list\` / \`google_calendar_create --summary <t> --start <ISO> [--end <ISO>]\` / \`google_calendar_update --event-id <id>\` / \`google_calendar_delete --event-id <id>\`
- Drive: \`google_drive_search [--name <t>] [--fulltext <t>]\` / \`google_drive_read --file-id <id>\`
- Docs: \`google_docs_create --title <t> [--body <t>]\` / \`google_docs_read --document-id <id>\` / \`google_docs_append --document-id <id> --text <t>\`
- Gmail: \`google_gmail_search --query <q>\` / \`google_gmail_read --message-id <id>\` / \`google_gmail_draft --to <addr> [--subject <t>] [--body <t>]\`
- 安全ポリシー: 削除（\`google_calendar_delete\`）はユーザーの明示指示時のみ。Gmail は下書き作成（\`google_gmail_draft\`）までで送信はしない。

## 長時間処理

xangiのデフォルトタイムアウトは30分（1800000ms、env TIMEOUT_MS で変更可）。
- ターン終了後も存続する方法を使い、具体手順はワークスペースの指示に従う
- 開始報告前に存続を確認し、ログと終了状態を保存する
- 確認できなければ開始済み・完了済みと報告しない

## 自己再起動

- 現在のxangi自身は、\`xangi-cmd system_restart\`をこのターンから直接呼び、遅延・子プロセス・スケジューラへ委譲しない
- 受付を完了とみなさず、復帰後に状態・起動時刻・ログを確認する`;

/**
 * イベントトリガー（TRIGGER_ENABLED=true のときだけ注入される）
 *
 * Web/LINE はトリガーの投稿先にできない（platform: discord|slack のみ）ため、
 * チャットプラットフォーム（Discord/Slack）向けにだけ組み立て側で追加する。
 */
export const XANGI_COMMANDS_TRIGGER = `## イベントトリガー（完了時に自分を起こす）

長時間処理を環境固有の方法で永続実行するときは、その完了・失敗時の処理から \`xangi-cmd trigger\` を呼ぶと、新しいターンを起動して結果を報告できる：

\`\`\`
xangi-cmd trigger --channel <チャンネルID> --message "長時間処理が終了した。保存済みの終了状態とログを確認して報告して" --source <source>
\`\`\`

- 成功時だけでなく失敗時にもtriggerへ到達するようにする
- triggerを呼ぶ前に終了状態とログを保存し、次のターンで確認できるようにする
- 永続実行・完了検知・状態保存の具体的な方法はワークスペースの指示に従う
- \`--source\` は発火元の識別子（英数と \`_.:-\`）。チャンネルには \`⚡ trigger: <source>\` ラベルが付く
- 同一 source は 10 秒以内の連続発火、および前回ターンの実行中の発火が拒否される
- 同一チャンネル宛は実行中ターンの終了を待って直列に発火する
- 定刻チェックには従来どおり \`schedule_add\`、「イベント完了の瞬間に動きたい」場合は trigger を使う`;
