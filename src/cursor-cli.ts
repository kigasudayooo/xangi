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
import type { BaseRunnerOptions } from './base-runner.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { TimeoutController } from './timeout-controller.js';
import { buildCliEnv, clearManagedCliProcess, registerManagedCliProcess } from './cli-process.js';
import { appendJsonlChunk, flushJsonlBuffer } from './jsonl-buffer.js';

interface CursorJsonResponse {
  result?: string;
  response?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string | { message?: string };
}

interface CursorStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  timestamp_ms?: number;
  is_error?: boolean;
  result?: string;
  error?: string | { message?: string };
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
  tool_call?: Record<string, unknown>;
  call_id?: string;
}

export class CursorRunner extends EventEmitter implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private force: boolean;
  private trustWorkspace: boolean;
  private currentProcess: ChildProcess | null = null;
  private readonly timeoutController: TimeoutController;
  private readonly activeProcesses = new Map<string, ChildProcess>();

  constructor(options?: BaseRunnerOptions) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.force = process.env.CURSOR_FORCE !== 'false';
    this.trustWorkspace = process.env.CURSOR_TRUST_WORKSPACE !== 'false';
    this.timeoutController = new TimeoutController({ baseTimeoutMs: this.timeoutMs });
    for (const evt of ['timeout-started', 'timeout-extended', 'timeout-cleared'] as const) {
      this.timeoutController.on(evt, (payload) => this.emit(evt, payload));
    }
  }

  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    if (this.force) {
      args.push('--force');
    }

    if (this.trustWorkspace) {
      args.push('--trust');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--workspace', this.workdir);
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  private buildPrompt(rawPrompt: string): string {
    const systemPrompt = buildSystemPrompt();
    const promptWithRuntime = prependRuntimeContext(rawPrompt);
    return systemPrompt ? `${systemPrompt}\n\n---\n\n${promptWithRuntime}` : promptWithRuntime;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const fullPrompt = this.buildPrompt(prompt);
    const args = [...this.buildBaseArgs(options), '-p', fullPrompt, '--output-format', 'json'];

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[cursor] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    const { stdout, sessionId } = await this.execute(args, options?.channelId);
    const response = this.parseJsonResponse(stdout);
    const result = response.result ?? response.response ?? stdout;
    const finalSessionId = sessionId || response.session_id || '';

    if (response.is_error) {
      throw new Error(this.extractErrorMessage(response) ?? 'Cursor CLI returned error');
    }

    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId: finalSessionId });
    }

    return { result, sessionId: finalSessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cursor-agent', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: this.buildCursorEnv(channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(channelId, proc, this.activeProcesses, this.timeoutController);

      let stdout = '';
      let stderr = '';
      let sessionId = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
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

        if (code !== 0) {
          reject(new Error(`Cursor CLI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const json = JSON.parse(stdout.trim()) as CursorJsonResponse;
          sessionId = json.session_id ?? '';
        } catch {
          // stdout をそのまま返す
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        clearManagedCliProcess(channelId, this.activeProcesses, this.timeoutController, 'error');
        reject(new Error(`Failed to spawn Cursor CLI: ${err.message}`));
      });
    });
  }

  private parseJsonResponse(output: string): CursorJsonResponse {
    try {
      return JSON.parse(output.trim()) as CursorJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Cursor CLI response: ${output}`);
      }
      throw err;
    }
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const fullPrompt = this.buildPrompt(prompt);
    const args = [
      ...this.buildBaseArgs(options),
      '-p',
      fullPrompt,
      '--output-format',
      'stream-json',
      '--stream-partial-output',
    ];

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[cursor] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    return this.executeStream(args, callbacks, options?.channelId, options?.appSessionId);
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string,
    appSessionId?: string
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cursor-agent', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: this.buildCursorEnv(channelId),
      });
      this.currentProcess = proc;
      registerManagedCliProcess(channelId, proc, this.activeProcesses, this.timeoutController);

      let fullText = '';
      let sessionId = '';
      let buffer = '';
      let stderr = '';
      const emittedToolIds = new Set<string>();

      proc.stdout.on('data', (data) => {
        const parsed = appendJsonlChunk(buffer, data.toString());
        buffer = parsed.buffer;

        for (const line of parsed.lines) {
          try {
            const event = JSON.parse(line) as CursorStreamEvent;
            const result = this.handleStreamEvent(
              event,
              callbacks,
              emittedToolIds,
              fullText,
              sessionId
            );
            fullText = result.fullText;
            sessionId = result.sessionId;
            if (result.error) {
              reject(result.error);
              return;
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error('[cursor] stderr:', chunk);
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
            const event = JSON.parse(line) as CursorStreamEvent;
            const result = this.handleStreamEvent(
              event,
              callbacks,
              emittedToolIds,
              fullText,
              sessionId
            );
            fullText = result.fullText;
            sessionId = result.sessionId;
          } catch {
            // JSONパースエラーは無視
          }
        }

        if (code !== 0) {
          const error = new Error(`Cursor CLI exited with code ${code}: ${stderr}`);
          callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };

        if (appSessionId && this.workdir) {
          logResponse(this.workdir, appSessionId, { result: fullText, sessionId });
        }

        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        clearManagedCliProcess(channelId, this.activeProcesses, this.timeoutController, 'error');
        const error = new Error(`Failed to spawn Cursor CLI: ${err.message}`);
        callbacks.onError?.(error);
        reject(error);
      });
    });
  }

  private handleStreamEvent(
    event: CursorStreamEvent,
    callbacks: StreamCallbacks,
    emittedToolIds: Set<string>,
    fullText: string,
    sessionId: string
  ): { fullText: string; sessionId: string; error?: Error } {
    if (event.session_id) {
      sessionId = event.session_id;
    }

    if (event.type === 'assistant') {
      const text = this.extractAssistantText(event);
      if (text) {
        const result = this.applyAssistantText(text, Boolean(event.timestamp_ms), fullText);
        fullText = result.fullText;
        if (result.emitText !== undefined) {
          callbacks.onText?.(result.emitText, fullText);
        }
      }
    }

    if (event.type === 'tool_call' && event.subtype === 'started') {
      const tool = this.extractToolUse(event);
      if (tool && !emittedToolIds.has(tool.id)) {
        emittedToolIds.add(tool.id);
        callbacks.onToolUse?.(tool.name, tool.input);
      }
    }

    if (event.type === 'result') {
      if (event.session_id) {
        sessionId = event.session_id;
      }
      if (event.is_error) {
        const error = new Error(this.extractErrorMessage(event) ?? 'Cursor CLI returned error');
        callbacks.onError?.(error);
        return { fullText, sessionId, error };
      }
      if (event.result && !fullText.endsWith(event.result)) {
        fullText = fullText ? `${fullText}${event.result}` : event.result;
      }
    }

    return { fullText, sessionId };
  }

  private applyAssistantText(
    text: string,
    isDelta: boolean,
    fullText: string
  ): { fullText: string; emitText?: string } {
    if (isDelta) {
      if (text.startsWith(fullText)) {
        const delta = text.slice(fullText.length);
        return delta ? { fullText: text, emitText: delta } : { fullText };
      }

      return { fullText: `${fullText}${text}`, emitText: text };
    }

    // Cursor emits a final assistant event containing the complete response after
    // token-level partial events. Treat it as canonical text, not another delta.
    if (text === fullText || fullText.endsWith(text)) {
      return { fullText };
    }

    if (text.startsWith(fullText)) {
      const delta = text.slice(fullText.length);
      return delta ? { fullText: text, emitText: delta } : { fullText };
    }

    return { fullText: text };
  }

  private extractAssistantText(event: CursorStreamEvent): string {
    const content = event.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }

  private extractToolUse(
    event: CursorStreamEvent
  ): { id: string; name: string; input: Record<string, unknown> } | null {
    const raw = event.tool_call;
    if (!raw) return null;

    const entries = Object.entries(raw);
    for (const [kind, value] of entries) {
      if (!kind.endsWith('ToolCall') || !value || typeof value !== 'object') continue;
      const call = value as { args?: unknown };
      const rawName = kind.replace(/ToolCall$/, '');
      const name = rawName ? `${rawName.charAt(0).toUpperCase()}${rawName.slice(1)}` : 'Tool';
      const id = event.call_id ?? `${name}:${JSON.stringify(call.args ?? {})}`;
      return {
        id,
        name,
        input: this.toRecord(call.args),
      };
    }

    const id = event.call_id ?? JSON.stringify(raw);
    return { id, name: 'tool', input: this.toRecord(raw) };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private extractErrorMessage(event: CursorJsonResponse | CursorStreamEvent): string | undefined {
    const error = event.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    return undefined;
  }

  private buildCursorEnv(channelId?: string): NodeJS.ProcessEnv {
    const env = buildCliEnv(channelId);
    if (process.env.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
    }
    return env;
  }

  cancel(channelId?: string): boolean {
    if (channelId) {
      const proc = this.activeProcesses.get(channelId);
      if (proc) {
        console.log(`[cursor] Cancelling request for channel ${channelId}`);
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
    console.log('[cursor] Cancelling current request');
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

  extendTimeout(channelId: string, additionalMs?: number): ExtendTimeoutResult {
    return this.timeoutController.extend(channelId, additionalMs);
  }
}
