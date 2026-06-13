/**
 * ワークスペース hooks — エージェントループのライフサイクルに外部検証プロセスを挟む機構。
 *
 * Claude Code / Codex CLI の Stop hook と互換の契約を採用する:
 * - hook はコマンドとして spawn され、stdin に JSON ペイロードを受け取る
 * - exit 0 + stdout JSON `{"decision":"block","reason":"..."}` → block（reason 必須）
 * - exit 2 + stderr 非空 → block（stderr が reason）
 * - それ以外（exit 0 で出力なし / JSON でない / 他の exit code / timeout / spawn 失敗）→ 素通り
 *
 * 安全設計はフェイルオープン: hook 側のどんな異常でも本体の応答を止めない。
 * block は「ターン終了を 1 回差し戻してフィードバックを LLM に返す」ナッジであって強制ではない。
 *
 * 設定はワークスペースの `hooks/hooks.json`（XANGI_HOOKS_FILE で上書き可能）:
 * ```json
 * {
 *   "hooks": {
 *     "Stop": [
 *       { "command": "uv run hooks/check-run-and-forget/hook.py", "timeoutMs": 10000 }
 *     ]
 *   }
 * }
 * ```
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HookDefinition {
  /** shell で実行されるコマンド（cwd はワークスペース） */
  command: string;
  /** タイムアウト ms（既定 10000、上限 60000）。超過時は kill して素通り */
  timeoutMs?: number;
}

export interface HooksConfig {
  hooks: {
    Stop?: HookDefinition[];
  };
}

/**
 * Stop hook の stdin ペイロード。
 * フィールド名は Claude Code の Stop hook 入力に揃える（hook スクリプトの共通化のため）。
 * `channel_id` / `tools_called` は xangi 拡張。transcript を parse しなくても
 * 「このターンでどのツールが実行されたか」を hook 側が直接判定できる。
 */
export interface StopHookPayload {
  hook_event_name: 'Stop';
  session_id: string;
  cwd: string;
  /** Stop hook の block による継続ラウンド中なら true（現状 xangi は再チェックしないため常に false） */
  stop_hook_active: boolean;
  /** このターンの最終応答テキスト */
  last_assistant_message: string;
  /** xangi 拡張: チャンネル ID */
  channel_id?: string;
  /** xangi 拡張: このターンで実行されたツール名（実行順、重複あり） */
  tools_called: string[];
}

export interface StopHookVerdict {
  block: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** hook の stdout/stderr の取り込み上限（暴走 hook がメモリを食わないように） */
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * hooks 設定ファイルを読む。ファイル不在は「hooks 未設定」として null。
 * 壊れた JSON / 不正なスキーマはフェイルオープン（警告して null）。
 */
export function loadHooksConfig(workspace: string, fileOverride?: string): HooksConfig | null {
  const file = fileOverride || path.join(workspace, 'hooks', 'hooks.json');
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[hooks] Failed to read hooks config ${file}: ${String(err)}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[hooks] hooks config is not valid JSON (${file}): ${String(err)}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[hooks] hooks config must be an object (${file})`);
    return null;
  }
  const hooksField = (parsed as Record<string, unknown>).hooks;
  if (!hooksField || typeof hooksField !== 'object' || Array.isArray(hooksField)) {
    console.warn(`[hooks] hooks config missing "hooks" object (${file})`);
    return null;
  }

  const stopRaw = (hooksField as Record<string, unknown>).Stop;
  const stop: HookDefinition[] = [];
  if (stopRaw !== undefined) {
    if (!Array.isArray(stopRaw)) {
      console.warn(`[hooks] hooks.Stop must be an array (${file})`);
    } else {
      for (const entry of stopRaw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          console.warn(`[hooks] hooks.Stop entry must be an object, skipped (${file})`);
          continue;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.command !== 'string' || !e.command.trim()) {
          console.warn(`[hooks] hooks.Stop entry missing "command", skipped (${file})`);
          continue;
        }
        const def: HookDefinition = { command: e.command };
        if (e.timeoutMs !== undefined) {
          if (typeof e.timeoutMs === 'number' && Number.isFinite(e.timeoutMs) && e.timeoutMs > 0) {
            def.timeoutMs = Math.min(e.timeoutMs, MAX_TIMEOUT_MS);
          } else {
            console.warn(`[hooks] invalid timeoutMs for "${e.command}", using default (${file})`);
          }
        }
        stop.push(def);
      }
    }
  }

  return { hooks: { Stop: stop } };
}

/**
 * Stop hook 群を実行するランナー。
 * hook は登録順に直列実行し、最初に block を返した hook で確定する。
 */
export class StopHookRunner {
  private readonly defs: HookDefinition[];
  private readonly cwd: string;

  constructor(defs: HookDefinition[], cwd: string) {
    this.defs = defs;
    this.cwd = cwd;
  }

  get count(): number {
    return this.defs.length;
  }

  async run(payload: StopHookPayload): Promise<StopHookVerdict> {
    for (const def of this.defs) {
      const verdict = await this.runOne(def, payload);
      if (verdict.block) return verdict;
    }
    return { block: false };
  }

  private runOne(def: HookDefinition, payload: StopHookPayload): Promise<StopHookVerdict> {
    return new Promise((resolve) => {
      const timeoutMs = Math.min(def.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(def.command, {
          shell: true,
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        console.warn(`[hooks] Failed to spawn stop hook "${def.command}": ${String(err)}`);
        resolve({ block: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (verdict: StopHookVerdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(verdict);
      };

      const timer = setTimeout(() => {
        console.warn(`[hooks] Stop hook timed out after ${timeoutMs}ms: ${def.command}`);
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
        settle({ block: false });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf-8');
      });

      child.on('error', (err) => {
        console.warn(`[hooks] Stop hook process error "${def.command}": ${String(err)}`);
        settle({ block: false });
      });

      child.on('close', (code) => {
        if (code === 2) {
          // Claude Code 互換: exit 2 + stderr が継続フィードバック
          const reason = stderr.trim();
          if (reason) {
            settle({ block: true, reason });
          } else {
            console.warn(`[hooks] Stop hook exited 2 without stderr reason: ${def.command}`);
            settle({ block: false });
          }
          return;
        }
        if (code !== 0) {
          console.warn(`[hooks] Stop hook exited with code ${code}: ${def.command}`);
          settle({ block: false });
          return;
        }
        const out = stdout.trim();
        if (!out) {
          settle({ block: false });
          return;
        }
        try {
          const json = JSON.parse(out) as Record<string, unknown>;
          if (json && json.decision === 'block') {
            const reason = typeof json.reason === 'string' ? json.reason.trim() : '';
            if (reason) {
              settle({ block: true, reason });
            } else {
              console.warn(
                `[hooks] Stop hook returned decision:block without reason: ${def.command}`
              );
              settle({ block: false });
            }
            return;
          }
          settle({ block: false });
        } catch {
          console.warn(
            `[hooks] Stop hook stdout is not valid JSON, ignored: ${def.command} (head: ${out.slice(0, 120)})`
          );
          settle({ block: false });
        }
      });

      // hook が stdin を読まずに即終了すると write が非同期 EPIPE を投げる。
      // try/catch では捕まらない (stream の 'error' イベント) ため、握りつぶして
      // close ハンドラ側で判定を確定させる。
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.write(JSON.stringify(payload));
        child.stdin?.end();
      } catch (err) {
        console.warn(`[hooks] Failed to write stop hook stdin "${def.command}": ${String(err)}`);
      }
    });
  }
}

/**
 * env と設定ファイルから StopHookRunner を組み立てる。
 *
 * デフォルト有効: ワークスペースに hooks 設定を「置いたら効く」（skills / triggers と
 * 同じ慣行、Claude Code の settings.json hooks とも揃える）。設定ファイルが無ければ
 * 何もしない no-op なので、有効でも既存ワークスペースへの影響はない。
 * XANGI_HOOKS_ENABLED=false はキルスイッチ（hooks.json を残したまま一時停止したい時用）。
 */
export function createStopHookRunner(workspace: string, env = process.env): StopHookRunner | null {
  if (env.XANGI_HOOKS_ENABLED === 'false') return null;
  const config = loadHooksConfig(workspace, env.XANGI_HOOKS_FILE);
  const defs = config?.hooks.Stop ?? [];
  if (defs.length === 0) {
    if (config) {
      console.warn('[hooks] hooks config found but no Stop hooks configured');
    }
    return null;
  }
  console.log(`[hooks] Stop hooks enabled: ${defs.length} hook(s)`);
  return new StopHookRunner(defs, workspace);
}
