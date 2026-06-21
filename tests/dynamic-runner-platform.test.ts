import { describe, expect, it } from 'vitest';
import { BackendResolver } from '../src/backend-resolver.js';
import type { Config } from '../src/config.js';
import { DynamicRunnerManager } from '../src/dynamic-runner.js';

function makeConfig(platform: Config['agent']['platform']): Config {
  return {
    discord: { enabled: true, token: 'x' },
    slack: { enabled: false },
    line: { enabled: false },
    agent: {
      backend: 'local-llm',
      config: { model: 'test' },
      platform,
    },
    scheduler: { enabled: false, startupEnabled: false },
    claudeCode: {},
  } as Config;
}

describe('DynamicRunnerManager platform routing', () => {
  it('creates a platform-specific runner when a Web/Even turn uses a Discord default runner', () => {
    const config = makeConfig('discord');
    const manager = new DynamicRunnerManager(config, new BackendResolver(config));
    const resolved = new BackendResolver(config).resolve('web-chat:session-1');

    const runner = (
      manager as unknown as {
        getRunner(
          channelId: string,
          resolved: typeof resolved,
          platform?: Config['agent']['platform']
        ): unknown;
      }
    ).getRunner('web-chat:session-1', resolved, 'web');

    expect((runner as { platform?: string }).platform).toBe('web');
  });

  it('does not leak the default model into a backend-only channel override', () => {
    const originalOverrides = process.env.CHANNEL_OVERRIDES;
    process.env.CHANNEL_OVERRIDES = JSON.stringify({
      'discord-channel': { backend: 'cursor' },
    });

    try {
      const config = {
        ...makeConfig('discord'),
        agent: {
          backend: 'grok',
          config: { model: 'grok-build' },
          platform: 'discord',
        },
      } as Config;
      const resolver = new BackendResolver(config);
      const manager = new DynamicRunnerManager(config, resolver);
      const resolved = resolver.resolve('discord-channel');

      const runner = (
        manager as unknown as {
          getRunner(
            channelId: string,
            resolved: typeof resolved,
            platform?: Config['agent']['platform']
          ): unknown;
        }
      ).getRunner('discord-channel', resolved, 'discord');

      expect((runner as { model?: string }).model).toBeUndefined();
    } finally {
      if (originalOverrides === undefined) {
        delete process.env.CHANNEL_OVERRIDES;
      } else {
        process.env.CHANNEL_OVERRIDES = originalOverrides;
      }
    }
  });
});
