import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StreamCallbacks,
  TimeoutState,
  ExtendTimeoutResult,
} from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { buildSystemPrompt } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { TimeoutController } from './timeout-controller.js';
import type { ChatPlatform } from './prompts/index.js';
import { buildCliEnv, clearManagedCliProcess, registerManagedCliProcess } from './cli-process.js';
import { appendJsonlChunk, flushJsonlBuffer } from './jsonl-buffer.js';

export interface CodexOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  platform?: ChatPlatform;
}

/**
 * Codex CLI 0.98.0 の JSONL イベント型定義
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  session_id?: string;
  name?: string;
  command?: string;
  arguments?: string | Record<string, unknown>;
  input?: string | Record<string, unknown>;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    command?: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
  };
  payload?: {
    type?: string;
    name?: string;
    command?: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
    item?: CodexEvent['item'];
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  // エラーイベント用（type: 'error' は message、type: 'turn.failed' は error.message）
  message?: string;
  error?: {
    message?: string;
  };
  // フォールバック用
  content?: string;
  result?: string;
}

/**
 * Codex CLI を実行するランナー（0.98.0 対応）
 */
export class CodexRunner extends EventEmitter implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;
  private currentProcess: ChildProcess | null = null;
  /** チャンネル別タイムアウト管理（UI の +5m / 残り表示 / 自動 kill 連動） */
  private readonly timeoutController: TimeoutController;
  /** 同時実行されている子プロセスを channelId で索く（並列セッション対応） */
  private readonly activeProcesses = new Map<string, ChildProcess>();

  constructor(options?: CodexOptions) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = buildSystemPrompt(options?.platform);
    this.timeoutController = new TimeoutController({ baseTimeoutMs: this.timeoutMs });
    for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
      this.timeoutController.on(evt, (payload) => this.emit(evt, payload));
    }
  }

  /**
   * コマンド引数を構築（run/runStream 共通）
   */
  private buildArgs(prompt: string, options?: RunOptions): string[] {
    const args: string[] = ['exec', '--json'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }

    // gitリポジトリ外でも動作するように
    args.push('--skip-git-repo-check');

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--cd', this.workdir);
    }

    // セッション継続（--cd, --model等のオプションはresumeサブコマンドの前に置く必要がある）
    if (options?.sessionId) {
      args.push('resume', options.sessionId);
    }

    // システムプロンプトをプロンプトに注入
    const fullPrompt = this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${prompt}`
      : prompt;

    args.push(fullPrompt);

    return args;
  }

  /**
   * JSONL 行からセッション ID を抽出
   */
  private extractSessionId(json: CodexEvent): string | undefined {
    // Codex 0.98.0 は thread.started イベントで thread_id を返す
    if (json.type === 'thread.started' && json.thread_id) {
      return json.thread_id;
    }
    // フォールバック
    if (json.thread_id) return json.thread_id;
    if (json.session_id) return json.session_id;
    return undefined;
  }

  /**
   * JSONL 行からテキストを抽出
   */
  private extractText(json: CodexEvent): { text: string; isComplete: boolean } | null {
    // agent_message の完了 — 最終的な回答テキスト
    if (
      json.type === 'item.completed' &&
      json.item?.type === 'agent_message' &&
      typeof json.item.text === 'string'
    ) {
      return { text: json.item.text, isComplete: true };
    }
    // フォールバック: message イベント
    if (json.type === 'message' && json.content) {
      return { text: json.content, isComplete: true };
    }
    // フォールバック: result フィールド
    if (json.result) {
      return { text: json.result, isComplete: true };
    }
    return null;
  }

  /**
   * JSONL 行から Codex 側のエラーメッセージを抽出する。
   * Codex は失敗時に stdout へ `error` / `turn.failed` イベントを流すが、
   * exit code だけ見ていると「利用上限到達」等の本当の理由が握り潰される。
   */
  private extractErrorMessage(json: CodexEvent): string | undefined {
    if (json.type === 'error' && json.message) {
      return json.message;
    }
    if (json.type === 'turn.failed' && json.error?.message) {
      return json.error.message;
    }
    return undefined;
  }

  private parseToolInput(input: unknown): Record<string, unknown> {
    if (!input) return {};
    if (typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to a compact raw input summary.
      }
      return { input: trimmed };
    }
    return { input: String(input) };
  }

  private extractToolUse(
    json: CodexEvent
  ): { name: string; input: Record<string, unknown> } | null {
    const item = json.item ?? json.payload?.item;
    const payload = json.payload;
    const candidate = item ?? payload ?? json;
    const type = candidate.type;

    if (type === 'command_execution') {
      if (!candidate.command) return null;
      return {
        name: 'Bash',
        input: { command: candidate.command },
      };
    }

    if (type !== 'function_call' && type !== 'custom_tool_call' && type !== 'tool_call') {
      return null;
    }

    const name = candidate.name;
    if (!name) return null;
    return {
      name,
      input: this.parseToolInput(candidate.arguments ?? candidate.input),
    };
  }

  /**
   * exit code !== 0 時に投げるエラーメッセージを組み立てる。
   * Codex の error イベント本文 > stderr > exit code のみ、の優先順位で
   * できるだけ具体的な理由をユーザーに見せる。
   */
  private buildExitError(code: number | null, codexErrorMessage?: string, stderr?: string): Error {
    const base = `Codex CLI exited with code ${code}`;
    if (codexErrorMessage?.trim()) {
      return new Error(`${base}: ${codexErrorMessage.trim()}`);
    }
    const trimmedStderr = stderr?.trim();
    if (trimmedStderr) {
      return new Error(`${base}: ${trimmedStderr}`);
    }
    return new Error(base);
  }

  private isStaleResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('thread/resume failed') || message.includes('no rollout found');
  }

  async run(rawPrompt: string, options?: RunOptions): Promise<RunResult> {
    const prompt = prependRuntimeContext(rawPrompt);
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    let stdout: string;
    let sessionId: string;
    try {
      ({ stdout, sessionId } = await this.execute(args, options?.channelId));
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        throw error;
      }
      console.warn(
        `[codex] Resume failed for stale thread ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, { ...options, sessionId: undefined });
      ({ stdout, sessionId } = await this.execute(retryArgs, options?.channelId));
    }
    const result = this.extractResult(stdout);

    // トランスクリプトログ: 応答を記録
    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId });
    }

    return { result, sessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: buildCliEnv(channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(channelId, proc, this.activeProcesses, this.timeoutController);

      let stdout = '';
      let stderr = '';
      let sessionId = '';
      let codexErrorMessage: string | undefined;
      let buffer = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        const parsed = appendJsonlChunk(buffer, chunk);
        buffer = parsed.buffer;
        for (const line of parsed.lines) {
          try {
            const json = JSON.parse(line) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
            const errMsg = this.extractErrorMessage(json);
            if (errMsg) codexErrorMessage = errMsg;
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        clearManagedCliProcess(
          channelId,
          this.activeProcesses,
          this.timeoutController,
          code === 0 ? 'completed' : 'error'
        );

        for (const line of flushJsonlBuffer(buffer)) {
          try {
            const json = JSON.parse(line) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
            const errMsg = this.extractErrorMessage(json);
            if (errMsg) codexErrorMessage = errMsg;
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          reject(this.buildExitError(code, codexErrorMessage, stderr));
          return;
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        clearManagedCliProcess(channelId, this.activeProcesses, this.timeoutController, 'error');
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  private extractResult(output: string): string {
    const lines = output.trim().split('\n');
    const messageParts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line) as CodexEvent;
        const extracted = this.extractText(json);
        if (extracted) {
          if (extracted.isComplete) {
            messageParts.push(extracted.text);
          }
        }
      } catch {
        // JSONパースエラーは無視
      }
    }

    // 最後の agent_message を使用（複数ターンの場合）
    return messageParts.length > 0 ? messageParts[messageParts.length - 1] : output;
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    rawPrompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const prompt = prependRuntimeContext(rawPrompt);
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    try {
      return await this.executeStream(args, callbacks, options?.channelId, options?.appSessionId, {
        notifyOnError: false,
      });
    } catch (error) {
      if (!options?.sessionId || !this.isStaleResumeError(error)) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
        throw error;
      }
      console.warn(
        `[codex] Resume failed for stale thread ${options.sessionId.slice(0, 8)}..., retrying with a new session`
      );
      const retryArgs = this.buildArgs(prompt, { ...options, sessionId: undefined });
      return this.executeStream(retryArgs, callbacks, options?.channelId, options?.appSessionId);
    }
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string,
    appSessionId?: string,
    opts: { notifyOnError?: boolean } = {}
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: buildCliEnv(channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(channelId, proc, this.activeProcesses, this.timeoutController);

      let fullText = '';
      let sessionId = '';
      let buffer = '';
      let stderr = '';
      let codexErrorMessage: string | undefined;
      const emittedToolIds = new Set<string>();

      proc.stdout.on('data', (data) => {
        const parsed = appendJsonlChunk(buffer, data.toString());
        buffer = parsed.buffer;

        for (const line of parsed.lines) {
          try {
            const json = JSON.parse(line) as CodexEvent;

            // セッションID抽出
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;

            // エラーイベント抽出（利用上限到達などの本当の理由）
            const errMsg = this.extractErrorMessage(json);
            if (errMsg) codexErrorMessage = errMsg;

            const toolUse = this.extractToolUse(json);
            if (toolUse) {
              const itemId = json.item?.id ?? json.payload?.item?.id;
              const eventKey = itemId ?? `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
              if (!emittedToolIds.has(eventKey)) {
                emittedToolIds.add(eventKey);
                callbacks.onToolUse?.(toolUse.name, toolUse.input);
              }
            }

            // テキスト抽出
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
              callbacks.onText?.(extracted.text, fullText);
            }

            // トークン使用量ログ
            if (json.type === 'turn.completed' && json.usage) {
              console.log(
                `[codex] Usage: input=${json.usage.input_tokens} (cached=${json.usage.cached_input_tokens ?? 0}), output=${json.usage.output_tokens}`
              );
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error('[codex] stderr:', chunk);
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        clearManagedCliProcess(
          channelId,
          this.activeProcesses,
          this.timeoutController,
          code === 0 ? 'completed' : 'error'
        );

        // 残りのバッファを処理
        for (const line of flushJsonlBuffer(buffer)) {
          try {
            const json = JSON.parse(line) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
            const errMsg = this.extractErrorMessage(json);
            if (errMsg) codexErrorMessage = errMsg;
            const toolUse = this.extractToolUse(json);
            if (toolUse) {
              const itemId = json.item?.id ?? json.payload?.item?.id;
              const eventKey = itemId ?? `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
              if (!emittedToolIds.has(eventKey)) {
                emittedToolIds.add(eventKey);
                callbacks.onToolUse?.(toolUse.name, toolUse.input);
              }
            }
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
            }
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          const error = this.buildExitError(code, codexErrorMessage, stderr);
          if (opts.notifyOnError !== false) {
            callbacks.onError?.(error);
          }
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };

        // トランスクリプトログ: 応答を記録
        if (appSessionId && this.workdir) {
          logResponse(this.workdir, appSessionId, { result: fullText, sessionId });
        }

        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        clearManagedCliProcess(channelId, this.activeProcesses, this.timeoutController, 'error');
        const error = new Error(`Failed to spawn Codex CLI: ${err.message}`);
        if (opts.notifyOnError !== false) {
          callbacks.onError?.(error);
        }
        reject(error);
      });
    });
  }

  /**
   * 現在処理中のリクエストをキャンセル
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const proc = this.activeProcesses.get(channelId);
      if (proc) {
        console.log(`[codex] Cancelling request for channel ${channelId}`);
        proc.kill();
        this.activeProcesses.delete(channelId);
        this.timeoutController.clear(channelId, 'error');
        return true;
      }
      return false;
    }
    if (!this.currentProcess) {
      return false;
    }
    console.log('[codex] Cancelling current request');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }

  hasRunner(channelId: string): boolean {
    return this.activeProcesses.has(channelId);
  }

  getTimeoutState(channelId?: string): TimeoutState {
    if (!channelId) return { active: false };
    return this.timeoutController.getState(channelId);
  }

  extendTimeout(channelId: string | undefined, additionalMs?: number): ExtendTimeoutResult {
    if (!channelId) return { ok: false, reason: 'no_active_request' };
    return this.timeoutController.extend(channelId, additionalMs);
  }
}
