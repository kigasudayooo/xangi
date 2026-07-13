import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TurnLatencyRecorder } from '../src/turn-latency.js';

describe('TurnLatencyRecorder', () => {
  it('writes decomposed first-turn latency as JSONL', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 1_100;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'discord',
        turnId: 'discord-msg-1',
        threadId: 'discord:thread-1',
        configuredBackend: 'codex',
        configuredModel: 'gpt-test',
        firstTurn: true,
        receivedAt: 1_000,
        workdir,
      },
      () => now
    );

    now = 1_250;
    recorder.markInitialReply();
    now = 1_300;
    recorder.markAgentStart();
    now = 1_400;
    recorder.markBackendReady();
    now = 1_800;
    recorder.markActivity();
    now = 2_100;
    recorder.markText();
    now = 2_600;
    recorder.markAgentComplete();
    now = 2_750;
    const record = recorder.finish('complete');

    expect(record).toMatchObject({
      first_turn: true,
      received_to_process_start_ms: 100,
      received_to_initial_reply_ms: 250,
      agent_start_to_first_activity_ms: 500,
      agent_start_to_backend_ready_ms: 100,
      agent_start_to_first_text_ms: 800,
      agent_duration_ms: 1300,
      received_to_final_reply_ms: 1750,
    });
    const line = readFileSync(join(workdir, 'logs/turn-latency/discord.jsonl'), 'utf8');
    expect(JSON.parse(line)).toEqual(record);
  });

  it('records only the first occurrence of each milestone and finishes once', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'xangi-latency-'));
    let now = 10;
    const recorder = new TurnLatencyRecorder(
      {
        platform: 'discord',
        turnId: 'turn',
        threadId: 'thread',
        firstTurn: false,
        receivedAt: 0,
        workdir,
      },
      () => now
    );
    recorder.markAgentStart();
    now = 20;
    recorder.markText();
    now = 30;
    recorder.markText();
    now = 40;

    expect(recorder.finish('error')?.agent_start_to_first_text_ms).toBe(10);
    expect(recorder.finish('complete')).toBeUndefined();
  });
});
