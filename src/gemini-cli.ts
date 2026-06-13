import type { RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { prependRuntimeContext } from './runtime-context.js';
import { logPrompt, logResponse } from './transcript-logger.js';
import { CliRunnerBase, type CliStreamParser } from './cli-runner-core.js';

/**
 * Gemini CLI の JSON 出力形式
 */
interface GeminiJsonResponse {
  session_id: string;
  response: string;
  stats?: {
    models?: Record<string, unknown>;
  };
}

/**
 * Gemini CLI の stream-json イベント形式
 */
interface GeminiStreamEvent {
  type: 'init' | 'message' | 'result';
  timestamp?: string;
  session_id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  status?: 'success' | 'error';
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

/**
 * Gemini CLI を実行するランナー
 */
export class GeminiRunner extends CliRunnerBase {
  protected readonly command = 'gemini';
  protected readonly displayName = 'Gemini CLI';
  protected readonly logPrefix = 'gemini';

  constructor(options?: BaseRunnerOptions) {
    super(options);
  }

  /**
   * コマンド引数を構築（run/runStream 共通部分）
   */
  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--yolo');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    // セッション継続
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
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'json',
    ];

    this.logExecution('Executing', options);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    let stdout: string;
    try {
      stdout = await this.collectOutput(args, options?.channelId);
    } catch (err) {
      // セッションresume失敗時は新規セッションでリトライ
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] Session resume failed, retrying without session: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'json',
        ];
        stdout = await this.collectOutput(retryArgs, options?.channelId);
      } else {
        throw err;
      }
    }

    const response = this.parseJsonResponse(stdout);

    // トランスクリプトログ: 応答を記録
    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, {
        result: response.response,
        sessionId: response.session_id,
      });
    }

    return {
      result: response.response,
      sessionId: response.session_id,
    };
  }

  private parseJsonResponse(output: string): GeminiJsonResponse {
    try {
      return JSON.parse(output.trim()) as GeminiJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Failed to parse Gemini CLI response: ${output}`);
      }
      throw err;
    }
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const fullPrompt = this.buildPrompt(prompt);
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'stream-json',
    ];

    this.logExecution('Streaming', options);

    // トランスクリプトログ: 送信プロンプトを記録
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    const onComplete = (result: RunResult) => {
      // トランスクリプトログ: 応答を記録
      if (options?.appSessionId && this.workdir) {
        logResponse(this.workdir, options.appSessionId, {
          result: result.result,
          sessionId: result.sessionId,
        });
      }
    };

    try {
      return await this.executeStreamCore(args, callbacks, {
        channelId: options?.channelId,
        notifyOnError: false,
        onComplete,
      });
    } catch (err) {
      // セッションresume失敗時は新規セッションでリトライ
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] Session resume failed, retrying without session: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'stream-json',
        ];
        return this.executeStreamCore(retryArgs, callbacks, {
          channelId: options?.channelId,
          onComplete,
        });
      }
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError?.(error);
      throw err;
    }
  }

  protected createStreamParser(callbacks: StreamCallbacks): CliStreamParser {
    let fullText = '';
    let sessionId = '';

    return {
      handleEvent: (json, phase) => {
        const event = json as GeminiStreamEvent;

        // セッションID取得（initイベントで返る）
        if (event.type === 'init' && event.session_id) {
          sessionId = event.session_id;
        }

        // アシスタントのメッセージ（delta）
        if (event.type === 'message' && event.role === 'assistant' && event.content) {
          fullText += event.content;
          if (phase === 'stream') {
            callbacks.onText?.(event.content, fullText);
          }
        }

        // 結果
        if (event.type === 'result') {
          if (event.session_id) {
            sessionId = event.session_id;
          }
          if (phase === 'stream') {
            if (event.status === 'error') {
              return new Error('Gemini CLI returned error');
            }
            // トークン使用量ログ
            if (event.stats) {
              console.log(
                `[gemini] Usage: input=${event.stats.input_tokens ?? 0}, output=${event.stats.output_tokens ?? 0}, cached=${event.stats.cached ?? 0}, duration=${event.stats.duration_ms ?? 0}ms`
              );
            }
          }
        }

        return undefined;
      },
      finalize: () => ({ result: fullText, sessionId }),
    };
  }
}
