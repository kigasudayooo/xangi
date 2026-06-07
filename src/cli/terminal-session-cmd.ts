interface TerminalSessionFlags {
  [key: string]: string | undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveBaseUrl(flags: TerminalSessionFlags): string {
  const explicit = flags['base-url'] || flags.url || process.env.XANGI_WEB_CHAT_URL;
  if (explicit) return trimTrailingSlash(explicit);
  const port = process.env.WEB_CHAT_PORT || '18888';
  return `http://127.0.0.1:${port}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export async function terminalSessionCmd(
  flags: TerminalSessionFlags,
  options: { defaultSource?: string; defaultTitle?: string } = {}
): Promise<string> {
  const baseUrl = resolveBaseUrl(flags);
  const source = flags.source || options.defaultSource || 'terminal';
  const title = flags.title || options.defaultTitle || 'Terminal Session';
  const token =
    flags.token || process.env.XANGI_DEVICE_INBOX_TOKEN || process.env.XANGI_PET_INBOX_TOKEN || '';

  const createRes = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
  const createBody = await readJson(createRes);
  if (!createRes.ok) {
    throw new Error(
      `Failed to create web session (${createRes.status}): ${String(createBody.error || createBody.raw || '')}`
    );
  }

  const sessionId = String(createBody.sessionId || '');
  if (!sessionId) {
    throw new Error('Failed to create web session: response did not include sessionId');
  }

  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).catch(() => undefined);

  const threadId = `web:${sessionId}`;
  const eventsUrl = `${baseUrl}/api/events/stream?thread_id=${encodeURIComponent(threadId)}`;
  const inboxUrl = `${baseUrl}/api/device/inbox`;
  const authLine = token
    ? `Authorization: Bearer ${token}`
    : '(token未設定: loopback/LAN/Tailscaleのみ許可)';

  return [
    'Terminal session created',
    `session_id: ${sessionId}`,
    `thread_id: ${threadId}`,
    `base_url: ${baseUrl}`,
    `events: ${eventsUrl}`,
    `inbox: ${inboxUrl}`,
    `auth: ${authLine}`,
    '',
    'POST body:',
    JSON.stringify({ appSessionId: sessionId, source, text: '<message>' }),
  ].join('\n');
}
