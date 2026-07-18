#!/usr/bin/env node
/**
 * google-auth-setup — Google OAuth refresh token を一度だけ取得するスクリプト
 *
 * Google Workspace 連携（xangi-cmd google_*）に必要な refresh token を取得する。
 * localhost の一時 HTTP サーバーで OAuth コールバックを受け、code を token に交換する。
 * 依存パッケージは不要（Node 標準の http / fetch のみ）。
 *
 * 使い方:
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node bin/google-auth-setup.mjs
 *   もしくは: node bin/google-auth-setup.mjs <client_id> <client_secret>
 *
 * 前提: Google Cloud Console で「デスクトップアプリ」タイプの OAuth クライアントを作成し、
 *       Calendar / Drive / Docs / Gmail API を有効化しておくこと。
 */

import http from 'http';
import { URL } from 'url';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.argv[2];
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.argv[3];

if (!clientId || !clientSecret) {
  console.error(
    'Error: GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET が必要です。\n' +
      '使い方: GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node bin/google-auth-setup.mjs\n' +
      '   または: node bin/google-auth-setup.mjs <client_id> <client_secret>'
  );
  process.exit(1);
}

async function exchangeCodeForToken(code, redirectUri) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error_description || payload.error || `status ${res.status}`);
  }
  return payload;
}

function main() {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    if (reqUrl.pathname !== '/oauth2callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const error = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`認可に失敗しました: ${error}`);
      console.error(`\nError: 認可に失敗しました: ${error}`);
      server.close();
      process.exit(1);
      return;
    }
    if (!code) {
      res.writeHead(400);
      res.end('code がありません');
      return;
    }

    const { port } = server.address();
    const redirectUri = `http://localhost:${port}/oauth2callback`;
    try {
      const token = await exchangeCodeForToken(code, redirectUri);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('認可が完了しました。ターミナルに戻って refresh token を確認してください。');

      if (!token.refresh_token) {
        console.error(
          '\nError: refresh_token が返却されませんでした。\n' +
            '既に同意済みのアカウントでは refresh_token が省略されることがあります。\n' +
            'https://myaccount.google.com/permissions で当該アプリのアクセスを削除してから再実行してください。'
        );
        server.close();
        process.exit(1);
        return;
      }

      console.log('\n========================================');
      console.log('refresh token の取得に成功しました。');
      console.log('以下を .env に追記してください:');
      console.log('----------------------------------------');
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${token.refresh_token}`);
      console.log('========================================');
      server.close();
      process.exit(0);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('token 交換に失敗しました。ターミナルを確認してください。');
      console.error(`\nError: token 交換に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      server.close();
      process.exit(1);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const redirectUri = `http://localhost:${port}/oauth2callback`;
    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    console.log('以下の URL をブラウザで開いて Google アカウントで同意してください:\n');
    console.log(authUrl.toString());
    console.log('\n（同意後、このスクリプトが自動でコールバックを受け取ります。Ctrl-C で中断）');
  });
}

main();
