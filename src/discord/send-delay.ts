// Discord does not publish stable per-route limits for channel message sends.
// Keep split follow-up sends below roughly 1 request/sec by default, with a
// small margin over 1000ms for scheduler/event-loop jitter. Operators can tune
// this via DISCORD_SPLIT_SEND_DELAY_MS, or set it to 0 to disable pacing.
const DEFAULT_SPLIT_SEND_DELAY_MS = 1100;

function getSplitSendDelayMs(): number {
  const raw = process.env.DISCORD_SPLIT_SEND_DELAY_MS;
  if (!raw) return DEFAULT_SPLIT_SEND_DELAY_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SPLIT_SEND_DELAY_MS;
  return parsed;
}

export async function waitBeforeFollowupDiscordSend(): Promise<void> {
  const delayMs = getSplitSendDelayMs();
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
