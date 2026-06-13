import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerStreamFinalizer,
  finalizeActiveStreams,
  activeStreamFinalizerCount,
} from '../src/stream-finalizer.js';

describe('stream-finalizer', () => {
  beforeEach(async () => {
    // 前のテストの残留 finalizer を掃除（finalize は registry をクリアする）
    await finalizeActiveStreams(10);
  });

  it('register / unregister で登録数が増減する', () => {
    expect(activeStreamFinalizerCount()).toBe(0);
    const un1 = registerStreamFinalizer(() => {});
    const un2 = registerStreamFinalizer(() => {});
    expect(activeStreamFinalizerCount()).toBe(2);
    un1();
    expect(activeStreamFinalizerCount()).toBe(1);
    un2();
    expect(activeStreamFinalizerCount()).toBe(0);
  });

  it('finalizeActiveStreams が登録済み finalizer を全部実行して registry をクリアする', async () => {
    const calls: string[] = [];
    registerStreamFinalizer(() => {
      calls.push('a');
    });
    registerStreamFinalizer(async () => {
      calls.push('b');
    });
    await finalizeActiveStreams();
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(activeStreamFinalizerCount()).toBe(0);
  });

  it('unregister 済みの finalizer は実行されない', async () => {
    const calls: string[] = [];
    const un = registerStreamFinalizer(() => {
      calls.push('removed');
    });
    registerStreamFinalizer(() => {
      calls.push('kept');
    });
    un();
    await finalizeActiveStreams();
    expect(calls).toEqual(['kept']);
  });

  it('finalizer が throw / reject しても他の finalizer は実行され、呼び出しは成功する', async () => {
    const calls: string[] = [];
    registerStreamFinalizer(() => {
      throw new Error('sync boom');
    });
    registerStreamFinalizer(async () => {
      throw new Error('async boom');
    });
    registerStreamFinalizer(() => {
      calls.push('ok');
    });
    await expect(finalizeActiveStreams()).resolves.toBeUndefined();
    expect(calls).toEqual(['ok']);
  });

  it('遅い finalizer は timeoutMs で打ち切られ shutdown を阻害しない', async () => {
    let slowDone = false;
    registerStreamFinalizer(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            slowDone = true;
            resolve();
          }, 5000);
        })
    );
    const start = Date.now();
    await finalizeActiveStreams(50);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(slowDone).toBe(false);
  });

  it('登録ゼロなら即 return する', async () => {
    const start = Date.now();
    await finalizeActiveStreams(5000);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('二重呼び出しは no-op (finalizer は一度だけ実行)', async () => {
    let count = 0;
    registerStreamFinalizer(() => {
      count++;
    });
    await finalizeActiveStreams();
    await finalizeActiveStreams();
    expect(count).toBe(1);
  });
});
