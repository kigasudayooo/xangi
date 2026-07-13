import type { WebClient } from '@slack/web-api';
import { buildPrefetchedHistoryBlock, type PrefetchedHistoryEntry } from './prefetched-history.js';

interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  files?: Array<{ name?: string; url_private?: string; permalink?: string }>;
}

function toEntry(message: SlackHistoryMessage): PrefetchedHistoryEntry {
  const seconds = Number.parseFloat(message.ts ?? '0');
  return {
    timestamp: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0),
    id: message.ts ?? 'unknown',
    author: message.username ?? message.user ?? message.bot_id ?? 'unknown',
    content: message.text ?? '',
    attachments: (message.files ?? []).map((file) => ({
      name: file.name ?? 'file',
      url: file.permalink ?? file.url_private ?? '',
    })),
  };
}

export async function prefetchSlackHistory(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  currentMessageTs: string,
  count: number
): Promise<string> {
  try {
    let messages: SlackHistoryMessage[];
    if (threadTs) {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: Math.min(100, count + 1),
      });
      messages = ((response.messages ?? []) as SlackHistoryMessage[])
        .filter((message) => message.ts !== currentMessageTs)
        .slice(-count);
    } else {
      const response = await client.conversations.history({
        channel: channelId,
        limit: Math.min(100, count),
        latest: currentMessageTs,
        inclusive: false,
      });
      messages = ((response.messages ?? []) as SlackHistoryMessage[]).slice(0, count).reverse();
    }
    return buildPrefetchedHistoryBlock('Slack', messages.map(toEntry));
  } catch (error) {
    console.warn(
      `[slack] Failed to prefetch history: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return buildPrefetchedHistoryBlock('Slack', []);
  }
}
