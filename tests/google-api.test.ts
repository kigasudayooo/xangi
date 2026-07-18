import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleApi, _resetTokenCache } from '../src/cli/google-api.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  calendarId: process.env.GOOGLE_CALENDAR_ID,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

const TOKEN_BODY = { access_token: 'ya29.test-token', expires_in: 3600 };

describe('googleApi', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh-token';
    delete process.env.GOOGLE_CALENDAR_ID;
    _resetTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, envName] of [
      ['clientId', 'GOOGLE_OAUTH_CLIENT_ID'],
      ['clientSecret', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      ['refreshToken', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
      ['calendarId', 'GOOGLE_CALENDAR_ID'],
    ] as const) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    _resetTokenCache();
    vi.restoreAllMocks();
  });

  it('fetches and caches the access token', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ items: [] });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await googleApi('google_calendar_list', {});
    await googleApi('google_calendar_list', {});

    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('oauth2.googleapis.com/token')
    );
    // 2回操作しても token 取得は1回だけ（キャッシュが効いている）
    expect(tokenCalls).toHaveLength(1);
    const [, tokenInit] = tokenCalls[0];
    expect(tokenInit?.method).toBe('POST');
    expect(String(tokenInit?.body)).toContain('grant_type=refresh_token');
  });

  it('throws when required env vars are missing', async () => {
    delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    globalThis.fetch = vi.fn(async () => jsonResponse(TOKEN_BODY)) as typeof fetch;

    await expect(googleApi('google_calendar_list', {})).rejects.toThrow(
      'GOOGLE_OAUTH_REFRESH_TOKEN'
    );
  });

  it('google_calendar_list requests events and formats them', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      return jsonResponse({
        items: [{ id: 'ev1', summary: '会議', start: { dateTime: '2026-07-20T15:00:00+09:00' } }],
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await googleApi('google_calendar_list', {});
    expect(result).toContain('会議');
    expect(result).toContain('ev1');

    const apiCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/calendar/v3/'));
    const parsed = new URL(String(apiCall?.[0]));
    expect(parsed.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(parsed.searchParams.get('singleEvents')).toBe('true');
    expect(apiCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer ya29.test-token' });
  });

  it('google_calendar_create posts an event with Asia/Tokyo timezone', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ id: 'new-ev', summary: '打合せ' });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await googleApi('google_calendar_create', {
      summary: '打合せ',
      start: '2026-07-20T15:00:00+09:00',
    });
    expect(result).toContain('new-ev');

    const apiCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/events'));
    const body = JSON.parse(String(apiCall?.[1]?.body));
    expect(body.summary).toBe('打合せ');
    expect(body.start.timeZone).toBe('Asia/Tokyo');
    expect(body.end.timeZone).toBe('Asia/Tokyo');
    // end 省略時は start + 60分
    expect(new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime()).toBe(
      60 * 60 * 1000
    );
  });

  it('google_docs_create creates a doc and returns its URL', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      if (url.endsWith(':batchUpdate')) return jsonResponse({});
      return jsonResponse({ documentId: 'doc123', title: 'メモ' });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await googleApi('google_docs_create', { title: 'メモ', body: '本文' });
    expect(result).toContain('https://docs.google.com/document/d/doc123/edit');

    const batchCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith(':batchUpdate'));
    const body = JSON.parse(String(batchCall?.[1]?.body));
    expect(body.requests[0].insertText.text).toBe('本文');
    expect(body.requests[0].insertText.location.index).toBe(1);
  });

  it('google_gmail_draft creates a draft only (no send) with base64url raw', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ id: 'draft1' });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await googleApi('google_gmail_draft', {
      to: 'a@example.com',
      subject: '件名',
      body: 'こんにちは',
    });
    expect(result).toContain('下書き');
    expect(result).toContain('draft1');

    const apiCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/drafts'));
    expect(String(apiCall?.[0])).toContain('/users/me/drafts');
    const body = JSON.parse(String(apiCall?.[1]?.body));
    const raw = body.message.raw as string;
    // base64url（+ / = を含まない）であること
    expect(raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf-8'
    );
    expect(decoded).toContain('To: a@example.com');
    expect(decoded).toContain('こんにちは');
  });

  it('throws with the Google API error message on failure', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ error: { message: 'Not Found' } }, 404);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(googleApi('google_calendar_delete', { 'event-id': 'missing' })).rejects.toThrow(
      'Not Found'
    );
  });

  it('google_drive_read returns non-text notice for binary files', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return jsonResponse(TOKEN_BODY);
      if (url.includes('/export') || url.includes('alt=media'))
        return textResponse('should-not-happen');
      return jsonResponse({ id: 'f1', name: 'photo.png', mimeType: 'image/png' });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await googleApi('google_drive_read', { 'file-id': 'f1' });
    expect(result).toContain('テキスト取得不可');
  });
});
