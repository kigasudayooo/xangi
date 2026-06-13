import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadHooksConfig,
  StopHookRunner,
  createStopHookRunner,
  type StopHookPayload,
} from '../src/hooks.js';

function payload(overrides: Partial<StopHookPayload> = {}): StopHookPayload {
  return {
    hook_event_name: 'Stop',
    session_id: 'sess-1',
    cwd: '/tmp',
    stop_hook_active: false,
    last_assistant_message: 'ビルドが終わったら確認して報告するね',
    channel_id: 'chan-1',
    tools_called: ['exec', 'read'],
    ...overrides,
  };
}

describe('loadHooksConfig', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'hooks-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('設定ファイルが無ければ null', () => {
    expect(loadHooksConfig(workdir)).toBeNull();
  });

  it('hooks/hooks.json から Stop hook 定義を読む', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(
      join(workdir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'echo hi', timeoutMs: 5000 }] } })
    );
    const config = loadHooksConfig(workdir);
    expect(config?.hooks.Stop).toEqual([{ command: 'echo hi', timeoutMs: 5000 }]);
  });

  it('fileOverride で別パスを指定できる', () => {
    const file = join(workdir, 'custom-hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ command: 'echo hi' }] } }));
    const config = loadHooksConfig(workdir, file);
    expect(config?.hooks.Stop).toHaveLength(1);
  });

  it('壊れた JSON はフェイルオープン (null)', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(join(workdir, 'hooks', 'hooks.json'), '{not json');
    expect(loadHooksConfig(workdir)).toBeNull();
  });

  it('command 欠落エントリ・不正 timeoutMs はスキップ/補正して残りを読む', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(
      join(workdir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { notCommand: true },
            { command: 'echo ok', timeoutMs: -5 },
            { command: 'echo capped', timeoutMs: 999_999 },
          ],
        },
      })
    );
    const config = loadHooksConfig(workdir);
    expect(config?.hooks.Stop).toEqual([
      { command: 'echo ok' },
      { command: 'echo capped', timeoutMs: 60_000 },
    ]);
  });

  it('hooks キーが無い設定は null', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(join(workdir, 'hooks', 'hooks.json'), JSON.stringify({ Stop: [] }));
    expect(loadHooksConfig(workdir)).toBeNull();
  });
});

describe('StopHookRunner', () => {
  it('decision:block + reason で block する', async () => {
    const runner = new StopHookRunner(
      [{ command: `node -e 'console.log(JSON.stringify({decision: "block", reason: "schedule_add を呼んでいません"}))'` }],
      '/tmp'
    );
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('schedule_add');
  });

  it('exit 2 + stderr で block する (Claude Code 互換)', async () => {
    const runner = new StopHookRunner(
      [{ command: `node -e 'console.error("stderr からの理由"); process.exit(2)'` }],
      '/tmp'
    );
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toBe('stderr からの理由');
  });

  it('exit 0 + 出力なしは素通り', async () => {
    const runner = new StopHookRunner([{ command: 'true' }], '/tmp');
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
  });

  it('decision:block でも reason 空なら素通り (フェイルオープン)', async () => {
    const runner = new StopHookRunner(
      [{ command: `node -e 'console.log(JSON.stringify({decision: "block"}))'` }],
      '/tmp'
    );
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
  });

  it('stdout が JSON でなければ素通り (フェイルオープン)', async () => {
    const runner = new StopHookRunner([{ command: 'echo not-json' }], '/tmp');
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
  });

  it('exit 2 で stderr 空なら素通り (フェイルオープン)', async () => {
    const runner = new StopHookRunner([{ command: `node -e 'process.exit(2)'` }], '/tmp');
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
  });

  it('exit 1 (hook 自体のエラー) は素通り (フェイルオープン)', async () => {
    const runner = new StopHookRunner([{ command: `node -e 'process.exit(1)'` }], '/tmp');
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
  });

  it('タイムアウトした hook は kill して素通り (フェイルオープン)', async () => {
    const runner = new StopHookRunner([{ command: 'sleep 30', timeoutMs: 300 }], '/tmp');
    const start = Date.now();
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(false);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('stdin に Claude Code 互換ペイロードが渡る (tools_called 拡張込み)', async () => {
    // stdin の JSON をそのまま検査して、期待フィールドがあれば block で返す
    const script = `
      let raw = '';
      process.stdin.on('data', (c) => (raw += c));
      process.stdin.on('end', () => {
        const p = JSON.parse(raw);
        const ok =
          p.hook_event_name === 'Stop' &&
          p.stop_hook_active === false &&
          typeof p.last_assistant_message === 'string' &&
          Array.isArray(p.tools_called) &&
          p.tools_called.includes('exec');
        console.log(JSON.stringify({ decision: ok ? 'block' : undefined, reason: ok ? 'payload-ok' : undefined }));
      });
    `;
    const runner = new StopHookRunner([{ command: `node -e "${script.replace(/\n/g, ' ')}"` }], '/tmp');
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toBe('payload-ok');
  });

  it('複数 hook は直列実行で最初の block が勝つ', async () => {
    const runner = new StopHookRunner(
      [
        { command: 'true' },
        { command: `node -e 'console.log(JSON.stringify({decision: "block", reason: "first"}))'` },
        { command: `node -e 'console.log(JSON.stringify({decision: "block", reason: "second"}))'` },
      ],
      '/tmp'
    );
    const verdict = await runner.run(payload());
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toBe('first');
  });
});

describe('createStopHookRunner', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'hooks-create-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('設定ファイルが無ければ null (デフォルト有効でも no-op)', () => {
    expect(createStopHookRunner(workdir, {})).toBeNull();
  });

  it('env 未設定 + Stop 定義ありで runner を返す (デフォルト有効)', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(
      join(workdir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'echo hi' }] } })
    );
    const runner = createStopHookRunner(workdir, {});
    expect(runner).not.toBeNull();
    expect(runner?.count).toBe(1);
  });

  it('XANGI_HOOKS_ENABLED=false はキルスイッチ (設定があっても null)', () => {
    mkdirSync(join(workdir, 'hooks'));
    writeFileSync(
      join(workdir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'echo hi' }] } })
    );
    expect(createStopHookRunner(workdir, { XANGI_HOOKS_ENABLED: 'false' })).toBeNull();
  });

  it('XANGI_HOOKS_FILE で設定ファイルを上書きできる', () => {
    const file = join(workdir, 'my-hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ command: 'echo hi' }] } }));
    const runner = createStopHookRunner(workdir, {
      XANGI_HOOKS_ENABLED: 'true',
      XANGI_HOOKS_FILE: file,
    });
    expect(runner?.count).toBe(1);
  });
});
