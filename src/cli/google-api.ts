/**
 * Google Workspace REST API direct command module.
 *
 * xangi-cmd uses this for Google Calendar / Drive / Docs / Gmail operations.
 * 外部 SDK には依存せず、素の fetch で REST API を直叩きする。OAuth2 の
 * refresh token フローで access token を取得し、モジュール内でキャッシュする。
 */

import { ValidationError } from '../errors.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_BASE = 'https://docs.googleapis.com/v1';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

const TIME_ZONE = 'Asia/Tokyo';
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;
const MAX_LIST_RESULTS = 10;
const MAX_BODY_CHARS = 4000;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | undefined;

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID environment variable is not set');
  if (!clientSecret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET environment variable is not set');
  if (!refreshToken) throw new Error('GOOGLE_OAUTH_REFRESH_TOKEN environment variable is not set');
  return { clientId, clientSecret, refreshToken };
}

function getCalendarId(flags: Record<string, string>): string {
  return flags['calendar'] || process.env.GOOGLE_CALENDAR_ID || 'primary';
}

/**
 * access token を取得する。expires_in の60秒前を失効扱いとして再取得し、
 * 有効なうちはモジュール内キャッシュを返す。
 */
async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const { clientId, clientSecret, refreshToken } = getOAuthConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || `status ${res.status}`;
    throw new Error(`Google OAuth token error: ${detail}`);
  }

  const expiresInMs = (payload.expires_in ?? 3600) * 1000;
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_MARGIN_MS,
  };
  return tokenCache.accessToken;
}

interface GoogleFetchOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  method?: string;
}

/**
 * Google REST API を叩く。エラー時は Google API のエラーメッセージを含む Error を throw。
 * raw:true のときは JSON パースせず生テキストを返す（Docs export / Drive ダウンロード用）。
 */
async function googleFetch<T>(url: string, options?: GoogleFetchOptions): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined && value !== '') {
      target.searchParams.set(key, value);
    }
  }

  const hasBody = options?.body !== undefined;
  const method = options?.method ?? (hasBody ? 'POST' : 'GET');
  const token = await getAccessToken();

  const res = await fetch(target, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text || `status ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      if (parsed.error) {
        message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || message;
      }
    } catch {
      // Body is not JSON; use raw text.
    }
    throw new Error(`Google API error ${res.status}: ${message}`);
  }

  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** raw テキストを返す fetch（Docs export / Drive alt=media 用） */
async function googleFetchRaw(
  url: string,
  query?: Record<string, string | undefined>
): Promise<string> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') target.searchParams.set(key, value);
  }
  const token = await getAccessToken();
  const res = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google API error ${res.status}: ${text || 'unknown_error'}`);
  }
  return text;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…（切り詰め）` : text;
}

/** ISO 文字列 or 日時文字列を Date に変換（不正なら throw） */
function parseDateTime(raw: string, label: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${label} を日時として解釈できません: ${raw}`);
  }
  return date;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '(日時なし)';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ja-JP', { timeZone: TIME_ZONE });
}

// ─── Calendar ───────────────────────────────────────────────────────

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

interface CalendarListResponse {
  items?: CalendarEvent[];
}

function eventStart(event: CalendarEvent): string | undefined {
  return event.start?.dateTime ?? event.start?.date;
}

async function calendarList(flags: Record<string, string>): Promise<string> {
  const calendarId = getCalendarId(flags);
  const timeMin = flags['time-min'] || new Date().toISOString();
  const timeMax = flags['time-max'];
  const maxResults = String(Math.min(Number.parseInt(flags['max-results'] || '', 10) || 10, 50));

  const response = await googleFetch<CalendarListResponse>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      query: {
        timeMin,
        timeMax,
        maxResults,
        singleEvents: 'true',
        orderBy: 'startTime',
      },
    }
  );

  const items = response.items ?? [];
  if (items.length === 0) return '📅 予定なし';

  const lines = items.slice(0, MAX_LIST_RESULTS).map((event) => {
    const when = formatDateTime(eventStart(event));
    return `- [${when}] ${event.summary ?? '(無題)'} (id: ${event.id})`;
  });
  return `📅 予定 (${items.length}件):\n${lines.join('\n')}`;
}

async function calendarCreate(flags: Record<string, string>): Promise<string> {
  const calendarId = getCalendarId(flags);
  const summary = flags['summary'] || flags['title'];
  const startRaw = flags['start'];
  if (!summary) throw new ValidationError('--summary is required');
  if (!startRaw) throw new ValidationError('--start is required');

  const startDate = parseDateTime(startRaw, '--start');
  const endDate = flags['end']
    ? parseDateTime(flags['end'], '--end')
    : new Date(startDate.getTime() + DEFAULT_EVENT_DURATION_MS);

  const event = await googleFetch<CalendarEvent>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      body: {
        summary,
        ...(flags['description'] ? { description: flags['description'] } : {}),
        start: { dateTime: startDate.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: endDate.toISOString(), timeZone: TIME_ZONE },
      },
    }
  );

  return `✅ 予定を作成しました: ${event.summary ?? summary} (id: ${event.id})`;
}

async function calendarUpdate(flags: Record<string, string>): Promise<string> {
  const calendarId = getCalendarId(flags);
  const eventId = flags['event-id'] || flags['id'];
  if (!eventId) throw new ValidationError('--event-id is required');

  const patch: Record<string, unknown> = {};
  if (flags['summary'] || flags['title']) patch.summary = flags['summary'] || flags['title'];
  if (flags['description']) patch.description = flags['description'];
  if (flags['start']) {
    patch.start = {
      dateTime: parseDateTime(flags['start'], '--start').toISOString(),
      timeZone: TIME_ZONE,
    };
  }
  if (flags['end']) {
    patch.end = {
      dateTime: parseDateTime(flags['end'], '--end').toISOString(),
      timeZone: TIME_ZONE,
    };
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      '更新するフィールド（--summary / --start / --end / --description）が未指定です'
    );
  }

  const event = await googleFetch<CalendarEvent>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: patch }
  );
  return `✏️ 予定を更新しました: ${event.summary ?? ''} (id: ${event.id})`;
}

async function calendarDelete(flags: Record<string, string>): Promise<string> {
  const calendarId = getCalendarId(flags);
  const eventId = flags['event-id'] || flags['id'];
  if (!eventId) throw new ValidationError('--event-id is required');

  await googleFetch<void>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
  return `🗑️ 予定を削除しました (id: ${eventId})`;
}

// ─── Drive ──────────────────────────────────────────────────────────

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
}

async function driveSearch(flags: Record<string, string>): Promise<string> {
  const name = flags['name'];
  const fullText = flags['fulltext'] || flags['query'] || flags['keyword'];
  const mimeType = flags['mime-type'] || flags['mimetype'];
  if (!name && !fullText) {
    throw new ValidationError('--name または --fulltext のいずれかが必要です');
  }

  const clauses: string[] = ['trashed = false'];
  if (name) clauses.push(`name contains '${name.replace(/'/g, "\\'")}'`);
  if (fullText) clauses.push(`fullText contains '${fullText.replace(/'/g, "\\'")}'`);
  if (mimeType) clauses.push(`mimeType = '${mimeType.replace(/'/g, "\\'")}'`);

  const response = await googleFetch<DriveListResponse>(`${DRIVE_BASE}/files`, {
    query: {
      q: clauses.join(' and '),
      pageSize: String(MAX_LIST_RESULTS),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    },
  });

  const files = response.files ?? [];
  if (files.length === 0) return '📂 該当ファイルなし';

  const lines = files.map((file) => {
    const when = formatDateTime(file.modifiedTime);
    return `- ${file.name ?? '(無題)'} (${when}) ${file.webViewLink ?? ''} [id: ${file.id}]`;
  });
  return `📂 Driveファイル (${files.length}件):\n${lines.join('\n')}`;
}

async function driveRead(flags: Record<string, string>): Promise<string> {
  const fileId = flags['file-id'] || flags['id'];
  if (!fileId) throw new ValidationError('--file-id is required');

  const meta = await googleFetch<DriveFile>(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
    query: { fields: 'id,name,mimeType,modifiedTime,webViewLink' },
  });
  const mimeType = meta.mimeType ?? '';
  const header = `📄 ${meta.name ?? fileId} (${mimeType})`;

  let content: string;
  if (mimeType === 'application/vnd.google-apps.document') {
    content = await googleFetchRaw(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export`, {
      mimeType: 'text/plain',
    });
  } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    content = await googleFetchRaw(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
      alt: 'media',
    });
  } else {
    return `${header}\n（バイナリまたは非対応形式のためテキスト取得不可）`;
  }

  return `${header}\n${truncate(content)}`;
}

// ─── Docs ───────────────────────────────────────────────────────────

interface DocsElement {
  endIndex?: number;
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string } }>;
  };
}

interface DocsDocument {
  documentId?: string;
  title?: string;
  body?: { content?: DocsElement[] };
}

function docsUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

function extractDocsText(doc: DocsDocument): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const el of element.paragraph?.elements ?? []) {
      if (el.textRun?.content) parts.push(el.textRun.content);
    }
  }
  return parts.join('');
}

async function docsCreate(flags: Record<string, string>): Promise<string> {
  const title = flags['title'];
  if (!title) throw new ValidationError('--title is required');
  const body = flags['body'] || flags['content'];

  const doc = await googleFetch<DocsDocument>(`${DOCS_BASE}/documents`, { body: { title } });
  const documentId = doc.documentId;
  if (!documentId) throw new Error('Google API error: documentId が返却されませんでした');

  if (body) {
    await googleFetch<unknown>(`${DOCS_BASE}/documents/${documentId}:batchUpdate`, {
      body: {
        requests: [{ insertText: { location: { index: 1 }, text: body } }],
      },
    });
  }

  return `📝 ドキュメントを作成しました: ${title}\n${docsUrl(documentId)}`;
}

async function docsRead(flags: Record<string, string>): Promise<string> {
  const documentId = flags['document-id'] || flags['id'];
  if (!documentId) throw new ValidationError('--document-id is required');

  const doc = await googleFetch<DocsDocument>(
    `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`
  );
  const text = extractDocsText(doc).trim();
  return `📝 ${doc.title ?? documentId}:\n${truncate(text || '(本文なし)')}`;
}

async function docsAppend(flags: Record<string, string>): Promise<string> {
  const documentId = flags['document-id'] || flags['id'];
  const text = flags['text'] || flags['content'];
  if (!documentId) throw new ValidationError('--document-id is required');
  if (!text) throw new ValidationError('--text is required');

  // 末尾の index を得るためにドキュメントを取得する。body.content の最後の要素の
  // endIndex は末尾の改行の後を指すため、その1つ前に挿入して末尾追記する。
  const doc = await googleFetch<DocsDocument>(
    `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`
  );
  const content = doc.body?.content ?? [];
  const lastEnd = content.length > 0 ? (content[content.length - 1].endIndex ?? 1) : 1;
  const insertIndex = Math.max(1, lastEnd - 1);

  await googleFetch<unknown>(
    `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      body: {
        requests: [{ insertText: { location: { index: insertIndex }, text } }],
      },
    }
  );
  return `📝 ドキュメントに追記しました: ${doc.title ?? documentId}\n${docsUrl(documentId)}`;
}

// ─── Gmail ──────────────────────────────────────────────────────────

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

interface GmailListResponse {
  messages?: Array<{ id?: string }>;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

/** payload を再帰的に辿って text/plain 本文を取り出す */
function extractGmailBody(part: GmailPart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = extractGmailBody(child);
    if (text) return text;
  }
  // text/plain が無ければ任意の body data を最後の手段として使う
  if (part.body?.data && !part.parts) return decodeBase64Url(part.body.data);
  return '';
}

async function gmailSearch(flags: Record<string, string>): Promise<string> {
  const query = flags['query'] || flags['q'] || flags['keyword'];
  if (!query) throw new ValidationError('--query is required');

  const list = await googleFetch<GmailListResponse>(`${GMAIL_BASE}/users/me/messages`, {
    query: { q: query, maxResults: String(MAX_LIST_RESULTS) },
  });
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return `📧 「${query}」に一致するメールなし`;

  // format=metadata は From / Subject / Date / To などの主要ヘッダをまとめて返す。
  const messages = await Promise.all(
    ids.map((id) =>
      googleFetch<GmailMessage>(`${GMAIL_BASE}/users/me/messages/${id}`, {
        query: { format: 'metadata' },
      })
    )
  );

  const lines = messages.map((m) => {
    const from = headerValue(m.payload?.headers, 'From');
    const subject = headerValue(m.payload?.headers, 'Subject');
    const date = headerValue(m.payload?.headers, 'Date');
    const snippet = (m.snippet ?? '').replace(/\s+/g, ' ').slice(0, 120);
    return `- [${date}] ${from} / ${subject || '(件名なし)'}: ${snippet} [id: ${m.id}]`;
  });
  return `📧 検索結果 (${messages.length}件):\n${lines.join('\n')}`;
}

async function gmailRead(flags: Record<string, string>): Promise<string> {
  const id = flags['message-id'] || flags['id'];
  if (!id) throw new ValidationError('--message-id is required');

  const message = await googleFetch<GmailMessage>(
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}`,
    { query: { format: 'full' } }
  );
  const from = headerValue(message.payload?.headers, 'From');
  const subject = headerValue(message.payload?.headers, 'Subject');
  const date = headerValue(message.payload?.headers, 'Date');
  const body = extractGmailBody(message.payload).trim() || message.snippet || '(本文なし)';

  return [
    `📧 ${subject || '(件名なし)'}`,
    `From: ${from}`,
    `Date: ${date}`,
    '',
    truncate(body),
  ].join('\n');
}

async function gmailDraft(flags: Record<string, string>): Promise<string> {
  const to = flags['to'];
  const subject = flags['subject'] || '';
  const body = flags['body'] || flags['content'] || '';
  if (!to) throw new ValidationError('--to is required');

  // RFC 2822 形式のメッセージを組み立てる。件名は UTF-8 を Base64 でエンコード。
  const encodedSubject = subject
    ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
    : '';
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n');

  const draft = await googleFetch<{ id?: string }>(`${GMAIL_BASE}/users/me/drafts`, {
    body: { message: { raw: encodeBase64Url(raw) } },
  });
  return `📧 下書きを作成しました（送信はしていません） to: ${to} (draftId: ${draft.id})`;
}

// ─── Dispatcher ─────────────────────────────────────────────────────

export async function googleApi(command: string, flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'google_calendar_list':
      return calendarList(flags);
    case 'google_calendar_create':
      return calendarCreate(flags);
    case 'google_calendar_update':
      return calendarUpdate(flags);
    case 'google_calendar_delete':
      return calendarDelete(flags);
    case 'google_drive_search':
      return driveSearch(flags);
    case 'google_drive_read':
      return driveRead(flags);
    case 'google_docs_create':
      return docsCreate(flags);
    case 'google_docs_read':
      return docsRead(flags);
    case 'google_docs_append':
      return docsAppend(flags);
    case 'google_gmail_search':
      return gmailSearch(flags);
    case 'google_gmail_read':
      return gmailRead(flags);
    case 'google_gmail_draft':
      return gmailDraft(flags);
    default:
      throw new ValidationError(`Unknown google command: ${command}`);
  }
}

/** テスト用にトークンキャッシュをリセットする */
export function _resetTokenCache(): void {
  tokenCache = undefined;
}
