import { afterEach, describe, expect, it } from 'vitest';
import { buildCliEnv } from '../src/cli-process.js';

describe('buildCliEnv', () => {
  const originalChannelId = process.env.XANGI_CHANNEL_ID;

  afterEach(() => {
    if (originalChannelId === undefined) {
      delete process.env.XANGI_CHANNEL_ID;
    } else {
      process.env.XANGI_CHANNEL_ID = originalChannelId;
    }
  });

  it('injects the provided channel id', () => {
    process.env.XANGI_CHANNEL_ID = 'parent-channel';

    const env = buildCliEnv('request-channel');

    expect(env.XANGI_CHANNEL_ID).toBe('request-channel');
  });

  it('does not leak the parent channel id when no channel is provided', () => {
    process.env.XANGI_CHANNEL_ID = 'parent-channel';

    const env = buildCliEnv();

    expect(env.XANGI_CHANNEL_ID).toBeUndefined();
  });
});
