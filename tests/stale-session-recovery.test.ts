import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeRunner } from '../src/claude-code.js';
import { CursorRunner } from '../src/cursor-cli.js';

// child_process をモック
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  class MockProcess extends EventEmitter {
    stdin = { write: vi.fn(), end: vi.fn() };
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;

    kill() {
      this.killed = true;
    }
  }

  const processes: MockProcess[] = [];

  return {
    spawn: vi.fn(() => {
      const p = new MockProcess();
      processes.push(p);
      return p;
    }),
    getMockProcesses: () => processes,
    clearMockProcesses: () => {
      processes.length = 0;
    },
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

async function getProcs() {
  const mod = (await import('child_process')) as unknown as {
    getMockProcesses: () => Array<{
      stdout: { emit: (e: string, d: string) => void };
      stderr: { emit: (e: string, d: string) => void };
      emit: (e: string, ...args: unknown[]) => void;
    }>;
    clearMockProcesses: () => void;
    spawn: ReturnType<typeof vi.fn>;
  };
  return mod;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('ClaudeCodeRunner stale session 自動回復', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getProcs()).clearMockProcesses();
  });

  it('run: No conversation found で新規セッションリトライする', async () => {
    const runner = new ClaudeCodeRunner({ timeoutMs: 5000 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const promise = runner.run('hello', { sessionId: 'stale-session-id', channelId: 'ch1' });
    await tick();

    const { getMockProcesses, spawn } = await getProcs();
    // 1 回目: resume 失敗
    getMockProcesses()[0].stderr.emit('data', 'No conversation found with session ID: stale');
    getMockProcesses()[0].emit('close', 1);
    await tick();

    // 2 回目: 新規セッションで成功
    expect(spawn).toHaveBeenCalledTimes(2);
    const retryArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(retryArgs).not.toContain('--resume');

    getMockProcesses()[1].stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'recovered',
        session_id: 'new-session',
        total_cost_usd: 0,
        duration_ms: 1,
      })
    );
    getMockProcesses()[1].emit('close', 0);

    const result = await promise;
    expect(result.result).toBe('recovered');
    expect(result.sessionId).toBe('new-session');
  });

  it('run: 無関係なエラーはリトライしない', async () => {
    const runner = new ClaudeCodeRunner({ timeoutMs: 5000 });
    const promise = runner.run('hello', { sessionId: 'sid', channelId: 'ch1' });
    await tick();

    const { getMockProcesses, spawn } = await getProcs();
    getMockProcesses()[0].stderr.emit('data', 'some other failure');
    getMockProcesses()[0].emit('close', 1);

    await expect(promise).rejects.toThrow('exited with code 1');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('runStream: stale resume は onError を出さずにリトライして完走する', async () => {
    const runner = new ClaudeCodeRunner({ timeoutMs: 5000 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const promise = runner.runStream(
      'hello',
      { onError },
      { sessionId: 'stale-session-id', channelId: 'ch1' }
    );
    await tick();

    const { getMockProcesses, spawn } = await getProcs();
    getMockProcesses()[0].stderr.emit('data', 'No conversation found with session ID');
    getMockProcesses()[0].emit('close', 1);
    await tick();

    expect(spawn).toHaveBeenCalledTimes(2);
    getMockProcesses()[1].stdout.emit(
      'data',
      JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 'new-sid' }) +
        '\n'
    );
    getMockProcesses()[1].emit('close', 0);

    const result = await promise;
    expect(result.sessionId).toBe('new-sid');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('CursorRunner stale session 自動回復', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getProcs()).clearMockProcesses();
  });

  it('run: sessionId 指定 + exit code エラーで新規セッションリトライする', async () => {
    const runner = new CursorRunner({ timeoutMs: 5000 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const promise = runner.run('hello', { sessionId: 'stale-sid', channelId: 'ch1' });
    await tick();

    const { getMockProcesses, spawn } = await getProcs();
    getMockProcesses()[0].stderr.emit('data', 'session could not be resumed');
    getMockProcesses()[0].emit('close', 1);
    await tick();

    expect(spawn).toHaveBeenCalledTimes(2);
    const retryArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(retryArgs).not.toContain('--resume');

    getMockProcesses()[1].stdout.emit(
      'data',
      JSON.stringify({ result: 'recovered', session_id: 'new-sid' })
    );
    getMockProcesses()[1].emit('close', 0);

    const result = await promise;
    expect(result.result).toBe('recovered');
  });

  it('run: sessionId 無しならリトライしない', async () => {
    const runner = new CursorRunner({ timeoutMs: 5000 });
    const promise = runner.run('hello', { channelId: 'ch1' });
    await tick();

    const { getMockProcesses, spawn } = await getProcs();
    getMockProcesses()[0].emit('close', 1);

    await expect(promise).rejects.toThrow('exited with code 1');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
