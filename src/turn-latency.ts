import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface TurnLatencyContext {
  platform: string;
  turnId: string;
  threadId: string;
  configuredBackend?: string;
  configuredModel?: string;
  firstTurn: boolean;
  receivedAt: number;
  workdir?: string;
}

type TurnOutcome = 'complete' | 'error' | 'cancelled';

export interface TurnLatencyRecord {
  ts: string;
  platform: string;
  turn_id: string;
  thread_id: string;
  configured_backend?: string;
  configured_model?: string;
  first_turn: boolean;
  outcome: TurnOutcome;
  received_to_process_start_ms: number;
  received_to_initial_reply_ms?: number;
  agent_start_to_first_activity_ms?: number;
  agent_start_to_backend_ready_ms?: number;
  agent_start_to_first_text_ms?: number;
  agent_duration_ms?: number;
  received_to_final_reply_ms: number;
}

type Clock = () => number;

export class TurnLatencyRecorder {
  private readonly processStartedAt: number;
  private initialReplyAt?: number;
  private agentStartedAt?: number;
  private firstActivityAt?: number;
  private backendReadyAt?: number;
  private firstTextAt?: number;
  private agentCompletedAt?: number;
  private written = false;

  constructor(
    private readonly context: TurnLatencyContext,
    private readonly clock: Clock = Date.now
  ) {
    this.processStartedAt = this.clock();
  }

  markInitialReply(): void {
    this.initialReplyAt ??= this.clock();
  }

  markAgentStart(): void {
    this.agentStartedAt ??= this.clock();
  }

  markActivity(): void {
    this.firstActivityAt ??= this.clock();
  }

  markBackendReady(): void {
    this.backendReadyAt ??= this.clock();
  }

  markText(): void {
    this.markActivity();
    this.firstTextAt ??= this.clock();
  }

  markAgentComplete(): void {
    this.agentCompletedAt ??= this.clock();
  }

  finish(outcome: TurnOutcome): TurnLatencyRecord | undefined {
    if (this.written) return undefined;
    this.written = true;
    const finishedAt = this.clock();
    const fromAgentStart = (at?: number) =>
      at !== undefined && this.agentStartedAt !== undefined ? at - this.agentStartedAt : undefined;
    const record: TurnLatencyRecord = {
      ts: new Date(finishedAt).toISOString(),
      platform: this.context.platform,
      turn_id: this.context.turnId,
      thread_id: this.context.threadId,
      configured_backend: this.context.configuredBackend,
      configured_model: this.context.configuredModel,
      first_turn: this.context.firstTurn,
      outcome,
      received_to_process_start_ms: Math.max(0, this.processStartedAt - this.context.receivedAt),
      received_to_initial_reply_ms:
        this.initialReplyAt === undefined
          ? undefined
          : Math.max(0, this.initialReplyAt - this.context.receivedAt),
      agent_start_to_first_activity_ms: fromAgentStart(this.firstActivityAt),
      agent_start_to_backend_ready_ms: fromAgentStart(this.backendReadyAt),
      agent_start_to_first_text_ms: fromAgentStart(this.firstTextAt),
      agent_duration_ms: fromAgentStart(this.agentCompletedAt),
      received_to_final_reply_ms: Math.max(0, finishedAt - this.context.receivedAt),
    };
    this.append(record);
    return record;
  }

  private append(record: TurnLatencyRecord): void {
    try {
      const workdir = this.context.workdir || process.env.WORKSPACE_PATH || process.cwd();
      const dir = join(workdir, 'logs', 'turn-latency');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${record.platform}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.warn(
        `[turn-latency] Failed to write metric: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
