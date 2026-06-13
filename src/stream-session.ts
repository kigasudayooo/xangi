import type { StreamCallbacks } from './agent-runner.js';
import { STREAM_UPDATE_INTERVAL_MS } from './constants.js';

/**
 * ストリーミング応答の表示状態。
 * プラットフォーム側はこれを受け取って message edit / chat.update / SSE 等で描画する。
 */
export interface StreamView {
  phase: 'thinking' | 'streaming';
  /** 思考中の表示ライン（スピナー + ステータス語 + 経過秒）。phase='streaming' では '' */
  statusLine: string;
  /** 受信済みの応答本文。phase='thinking' では '' */
  text: string;
  /** 実行中ツールの表示行（登録順、重複排除済み、最新 TOOL_HISTORY_MAX_LINES 行に cap 済み） */
  toolLines: string[];
  /** 開始からの経過秒 */
  elapsedSec: number;
}

export interface StreamSessionOptions {
  /**
   * 表示更新。Promise を返すと、その解決までストリーム本文の次回更新を抑制する
   * （edit API の応答待ちに重ねて edit を撃たないため）。
   * 思考中アニメーションの tick とツール行の追加は fire-and-forget で呼ばれる。
   */
  render: (view: StreamView) => Promise<unknown> | void;
  /** ツール行の整形。null / undefined を返すとそのツールは表示しない */
  formatToolLine?: (toolName: string, toolInput: Record<string, unknown>) => string | null;
  /** 思考中アニメーションの tick 間隔 ms (default 1000) */
  tickMs?: number;
  /** ストリーム本文の更新スロットリング間隔 ms (default STREAM_UPDATE_INTERVAL_MS) */
  streamUpdateIntervalMs?: number;
  /** スピナーのフレーム (default braille) */
  spinnerFrames?: string[];
  /** ローテーションするステータス語 (default 考え中/思考中/...) */
  statusVerbs?: string[];
  /** ステータス語を切り替える tick 数 (default 4 = 4秒ごと) */
  verbRotateTicks?: number;
}

/** ツール履歴表示のデフォルト最大行数 */
export const DEFAULT_TOOL_HISTORY_MAX_LINES = 10;

/** cap 済みリストの先頭に付く省略マーカー（二重 cap 防止の判定にも使う） */
const TOOL_LINES_OMITTED_PREFIX = '… (+';

/**
 * ツール履歴表示の最大行数 (env TOOL_HISTORY_MAX_LINES、default 10)。
 * 0 以下を指定すると無制限。
 */
export function toolHistoryMaxLines(): number {
  const raw = process.env.TOOL_HISTORY_MAX_LINES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TOOL_HISTORY_MAX_LINES;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? DEFAULT_TOOL_HISTORY_MAX_LINES : n;
}

/**
 * ツール表示行を最新 max 行に切り詰める。超過分は先頭の
 * `… (+N 件省略)` 1 行にまとめる。cap 済みのリスト（先頭が省略マーカー）は
 * そのまま返すので二重適用しても安全。
 */
export function capToolLines(lines: string[], max = toolHistoryMaxLines()): string[] {
  if (max <= 0 || lines.length <= max) return lines;
  if (lines[0]?.startsWith(TOOL_LINES_OMITTED_PREFIX)) return lines;
  const omitted = lines.length - max;
  return [`… (+${omitted} 件省略)`, ...lines.slice(-max)];
}

export const DEFAULT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const DEFAULT_STATUS_VERBS = [
  '考え中',
  '思考中',
  '調査中',
  '整理中',
  '組み立て中',
  '推敲中',
];

/**
 * 「考え中アニメーション → ストリーミング本文更新 → ツール行表示」の
 * プラットフォーム非依存コア。
 *
 * Discord / Slack / Web で三重実装されていた以下のロジックを一手に引き受ける:
 * - テキスト到着前の思考中アニメーション（スピナー + ステータス語 + 経過秒）
 * - 最初のテキスト到着での streaming フェーズへの遷移
 * - ストリーム本文更新のスロットリング（更新間隔 + 前回 edit の完了待ち）
 * - 実行中ツール行の蓄積（重複排除）と即時反映
 *
 * プラットフォーム固有の描画（message.edit / chat.update / ボタン・blocks 付与、
 * 文字数制限での切り詰め）は render コールバック側の責務。
 */
export class StreamSession {
  private phase: 'thinking' | 'streaming' = 'thinking';
  private text = '';
  private toolLines: string[] = [];
  private readonly startedAt = Date.now();
  private tick = 0;
  private verbIndex = 0;
  private interval: NodeJS.Timeout | undefined;
  private lastUpdateTime = 0;
  private pendingUpdate = false;
  private finished = false;

  constructor(private readonly opts: StreamSessionOptions) {}

  /** これまでに受信した本文（エラー時に途中テキストを残す用途） */
  get lastText(): string {
    return this.text;
  }

  /** 実行中ツールの表示行（エラー/完了表示に添える用途）。最新 TOOL_HISTORY_MAX_LINES 行に cap 済み */
  get currentToolLines(): string[] {
    return capToolLines([...this.toolLines]);
  }

  /** 最初のテキストを受信済みか */
  get isStreaming(): boolean {
    return this.phase === 'streaming';
  }

  /** 思考中アニメーションを開始する */
  start(): void {
    if (this.interval) return;
    const tickMs = this.opts.tickMs ?? 1000;
    this.interval = setInterval(() => {
      if (this.finished || this.phase !== 'thinking') return;
      this.tick++;
      const rotate = this.opts.verbRotateTicks ?? 4;
      if (this.tick % rotate === 0) this.verbIndex++;
      this.renderNow();
    }, tickMs);
  }

  /**
   * runner に渡す StreamCallbacks を生成する。
   * inner を渡すと、表示処理の後に同名のコールバックへ委譲する
   * （完了後ツール履歴の蓄積などプラットフォーム固有の処理用）。
   */
  callbacks(inner: StreamCallbacks = {}): StreamCallbacks {
    return {
      ...inner,
      onText: (chunk, fullText) => {
        this.text = fullText;
        this.phase = 'streaming';
        const intervalMs = this.opts.streamUpdateIntervalMs ?? STREAM_UPDATE_INTERVAL_MS;
        const now = Date.now();
        if (now - this.lastUpdateTime >= intervalMs && !this.pendingUpdate) {
          this.lastUpdateTime = now;
          this.renderThrottled();
        }
        inner.onText?.(chunk, fullText);
      },
      onToolUse: (toolName, toolInput) => {
        const line = this.opts.formatToolLine?.(toolName, toolInput);
        if (line && !this.toolLines.includes(line)) {
          this.toolLines.push(line);
          this.renderNow();
        }
        inner.onToolUse?.(toolName, toolInput);
      },
    };
  }

  /** 現在の表示状態を取得する（初期メッセージの組み立てにも使える） */
  view(): StreamView {
    return {
      phase: this.phase,
      statusLine: this.phase === 'thinking' ? this.buildStatusLine() : '',
      text: this.text,
      toolLines: capToolLines([...this.toolLines]),
      elapsedSec: this.elapsedSec(),
    };
  }

  /** 完了・エラー時に呼ぶ。アニメーションを停止し、以後の描画を抑止する */
  finish(): void {
    this.finished = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private elapsedSec(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  private buildStatusLine(): string {
    const frames = this.opts.spinnerFrames ?? DEFAULT_SPINNER_FRAMES;
    const verbs = this.opts.statusVerbs ?? DEFAULT_STATUS_VERBS;
    const frame = frames[this.tick % frames.length];
    const verb = verbs[this.verbIndex % verbs.length];
    return `${frame} ${verb}… ${this.elapsedSec()}s`;
  }

  /** fire-and-forget 描画（思考中 tick / ツール行追加） */
  private renderNow(): void {
    if (this.finished) return;
    Promise.resolve(this.opts.render(this.view())).catch(() => {});
  }

  /** ストリーム本文用の描画。完了まで pendingUpdate を立てて重複 edit を防ぐ */
  private renderThrottled(): void {
    if (this.finished) return;
    this.pendingUpdate = true;
    Promise.resolve(this.opts.render(this.view()))
      .catch(() => {})
      .finally(() => {
        this.pendingUpdate = false;
      });
  }
}
