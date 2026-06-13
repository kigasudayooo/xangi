/**
 * 全プラットフォーム共通のxangiコマンド（Discord/Slack/Web）
 */
export const XANGI_COMMANDS_COMMON = `## タイムアウト対策

xangiのデフォルトタイムアウトは30分（1800000ms、env TIMEOUT_MS で変更可）。
タイムアウトを超えそうな処理はバックグラウンド実行し、即座に「実行開始した」と応答を返すこと。
長時間処理は \`nohup\` を使うこと。`;

/**
 * イベントトリガー（TRIGGER_ENABLED=true のときだけ注入される）
 *
 * Web/LINE はトリガーの投稿先にできない（platform: discord|slack のみ）ため、
 * チャットプラットフォーム（Discord/Slack）向けにだけ組み立て側で追加する。
 */
export const XANGI_COMMANDS_TRIGGER = `## イベントトリガー（完了時に自分を起こす）

バックグラウンド実行した長時間処理は、コマンド末尾に \`xangi-cmd trigger\` を連結しておくと、完了した瞬間に新しいターンが起動して結果を報告できる：

\`\`\`bash
nohup bash -c 'docker build -t myapp . ; xangi-cmd trigger --channel <チャンネルID> --message "docker build が完了した。結果を確認して報告して" --source docker-build' > /tmp/build.log 2>&1 &
\`\`\`

- 区切りは \`;\` にする（\`&&\` だと失敗時に起動されず、失敗報告ができない）
- \`--source\` は発火元の識別子（英数と \`_.:-\`）。チャンネルには \`⚡ trigger: <source>\` ラベルが付く
- 同一 source は 10 秒以内の連続発火、および前回ターンの実行中の発火が拒否される
- 同一チャンネル宛は実行中ターンの終了を待って直列に発火する
- 定刻チェックには従来どおり \`schedule_add\`、「イベント完了の瞬間に動きたい」場合は trigger を使う`;
