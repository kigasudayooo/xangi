import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { prefetchSlackHistory } from '../src/slack-history-prefetch.js';

describe('prefetchSlackHistory', () => {
  it('uses channel history in normal mode and restores chronological order', async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        { ts: '20.0', user: 'U2', text: 'newer' },
        { ts: '10.0', user: 'U1', text: 'older' },
      ],
    });
    const client = { conversations: { history, replies: vi.fn() } } as unknown as WebClient;
    const block = await prefetchSlackHistory(client, 'C1', undefined, '30.0', 10);

    expect(history).toHaveBeenCalledWith({
      channel: 'C1',
      limit: 10,
      latest: '30.0',
      inclusive: false,
    });
    expect(block.indexOf('older')).toBeLessThan(block.indexOf('newer'));
  });

  it('uses thread replies and excludes the current message', async () => {
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { ts: '10.0', user: 'U1', text: 'root' },
        { ts: '20.0', user: 'U2', text: 'previous reply' },
        { ts: '30.0', user: 'U3', text: 'current reply' },
      ],
    });
    const client = { conversations: { history: vi.fn(), replies } } as unknown as WebClient;
    const block = await prefetchSlackHistory(client, 'C1', '10.0', '30.0', 10);

    expect(replies).toHaveBeenCalledWith({ channel: 'C1', ts: '10.0', limit: 11 });
    expect(block).toContain('root');
    expect(block).toContain('previous reply');
    expect(block).not.toContain('current reply');
  });
});
