import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('terminalSessionCmd', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.WEB_CHAT_PORT;
    delete process.env.XANGI_WEB_CHAT_URL;
    delete process.env.XANGI_DEVICE_INBOX_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('creates a web session and prints device inbox / filtered events URLs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, sessionId: 'sess123' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const { terminalSessionCmd } = await import('../src/cli/terminal-session-cmd.js');
    const out = await terminalSessionCmd({
      'base-url': 'http://127.0.0.1:18889/',
      title: 'G2 test',
      token: 'secret',
      source: 'g2',
    });

    expect(calls[0].url).toBe('http://127.0.0.1:18889/api/sessions');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[1].url).toBe('http://127.0.0.1:18889/api/sessions/sess123');
    expect(out).toContain('session_id: sess123');
    expect(out).toContain('thread_id: web:sess123');
    expect(out).toContain(
      'events: http://127.0.0.1:18889/api/events/stream?thread_id=web%3Asess123'
    );
    expect(out).toContain('inbox: http://127.0.0.1:18889/api/device/inbox');
    expect(out).toContain('Authorization: Bearer secret');
  });
});
