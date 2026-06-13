/**
 * プロセス終了時 (SIGTERM / SIGINT) に実行中のストリーミング表示を後始末する registry。
 *
 * 再起動・停止のタイミングで進行中ターンがあると、ストリーミング表示
 * (🔧 ツール行 + 末尾カーソル ▌、スピナー) が編集されないまま放置される (issue #293)。
 * プラットフォーム側 (Discord / Slack) はストリーミング表示を開始したら
 * finalizer を register し、正常完了・エラー処理後に unregister する。
 * shutdown ハンドラは finalizeActiveStreams() で残った表示を「中断」表示に確定させる。
 *
 * 制約: pm2 の kill timeout (デフォルト 1600ms) 内に完了する必要があるため、
 * timeoutMs (デフォルト 1200ms) で打ち切る。間に合わなかった表示は従来どおり残るが、
 * フェイルセーフであり shutdown 自体は阻害しない。
 */

type StreamFinalizer = () => Promise<void> | void;

const active = new Set<StreamFinalizer>();

/**
 * 実行中ストリーミング表示の finalizer を登録する。
 * 返り値の関数で登録解除する（正常完了・エラー処理後に必ず呼ぶこと）。
 */
export function registerStreamFinalizer(finalizer: StreamFinalizer): () => void {
  active.add(finalizer);
  return () => {
    active.delete(finalizer);
  };
}

/** 登録中の finalizer 数（テスト・診断用） */
export function activeStreamFinalizerCount(): number {
  return active.size;
}

/**
 * 登録されている finalizer をすべて並列実行する。
 * 個々のエラーは握りつぶし、timeoutMs で全体を打ち切る (shutdown を阻害しない)。
 * 呼び出し時点で registry はクリアされるため、二重呼び出しは no-op。
 */
export async function finalizeActiveStreams(timeoutMs = 1200): Promise<void> {
  if (active.size === 0) return;
  const finalizers = [...active];
  active.clear();
  const work = Promise.all(
    finalizers.map((fn) =>
      Promise.resolve()
        .then(fn)
        .catch(() => {})
    )
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
