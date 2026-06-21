import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitBeforeFollowupDiscordSend } from '../src/discord/send-delay.js';

describe('waitBeforeFollowupDiscordSend', () => {
  const originalDelay = process.env.DISCORD_SPLIT_SEND_DELAY_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.DISCORD_SPLIT_SEND_DELAY_MS;
  });

  afterEach(() => {
    if (originalDelay === undefined) {
      delete process.env.DISCORD_SPLIT_SEND_DELAY_MS;
    } else {
      process.env.DISCORD_SPLIT_SEND_DELAY_MS = originalDelay;
    }
    vi.useRealTimers();
  });

  it('waits 1100ms by default', async () => {
    let done = false;
    const promise = waitBeforeFollowupDiscordSend().then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(1099);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toBe(true);
  });

  it('can disable pacing with DISCORD_SPLIT_SEND_DELAY_MS=0', async () => {
    process.env.DISCORD_SPLIT_SEND_DELAY_MS = '0';

    await waitBeforeFollowupDiscordSend();
  });
});
