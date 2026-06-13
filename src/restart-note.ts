/**
 * プロセス再起動アーティファクトの注記。
 *
 * xangi が再起動（pm2 restart / 自己再起動 / クラッシュ復旧）した直後に
 * 既存セッションを resume すると、エージェント側のトランスクリプトには
 * 直前の未完了 tool 呼び出しが 'rejected'（拒否）形式で記録されている。
 * エージェントはこれを「ユーザーに拒否された」と誤解しがちなので、
 * 再起動後の各チャンネル最初の resume プロンプトに一度だけ注記を入れて
 * 誤解釈を防ぐ。
 */

const bootTime = new Date();
const notifiedChannels = new Set<string>();

/**
 * 再起動注記を取得する（チャンネルごとに一度だけ返す）。
 * - 既存セッションが無い（新規セッション）なら注記不要 → null
 * - 同じチャンネルで 2 回目以降 → null
 */
export function consumeRestartNote(channelId: string, hasExistingSession: boolean): string | null {
  if (notifiedChannels.has(channelId)) return null;
  notifiedChannels.add(channelId);
  if (!hasExistingSession) return null;

  const t = bootTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return (
    `[システム注記: xangi プロセスは ${t} に起動（再起動）した。` +
    `これより前の会話で未完了の tool 呼び出しが 'rejected' や中断として記録されている場合、` +
    `それはユーザーによる拒否ではなくプロセス再起動によるアーティファクトである。` +
    `拒否されたと解釈せず、必要なら結果を確認して作業を継続してよい]`
  );
}

/** テスト用: 通知済みチャンネルの記録をリセットする */
export function resetRestartNoteStateForTest(): void {
  notifiedChannels.clear();
}
