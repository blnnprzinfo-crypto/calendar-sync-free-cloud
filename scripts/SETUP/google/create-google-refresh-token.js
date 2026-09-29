'use strict';

require('dotenv').config();
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const clientId = String(process.env.GOOGLE_CALENDAR_CLIENT_ID || '').trim();
const clientSecret = String(process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '').trim();
const port = Number.parseInt(process.env.GOOGLE_OAUTH_LOOPBACK_PORT || '53682', 10);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const output = path.resolve(process.argv[2] || 'google-refresh-token.txt');

function base64url(buffer) { return buffer.toString('base64url'); }

async function main() {
  if (!clientId) throw new Error('Falta GOOGLE_CALENDAR_CLIENT_ID.');
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== '/oauth2callback') { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Estado OAuth no valido.'); return; }
      if (url.searchParams.get('error')) { reject(new Error(`Google rechazo OAuth: ${url.searchParams.get('error')}`)); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Autorizacion recibida. Ya puedes cerrar esta pestana.');
      server.close();
      resolve(url.searchParams.get('code'));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => console.log(`Abre esta URL para autorizar Google Calendar:\n${authorize.href}`));
  });
  const params = new URLSearchParams({
    client_id: clientId, code, code_verifier: verifier,
    grant_type: 'authorization_code', redirect_uri: redirectUri,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
  });
  const token = await response.json();
  if (!response.ok || !token.refresh_token) throw new Error(`Google OAuth fallo (${response.status}).`);
  fs.writeFileSync(output, `${token.refresh_token}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(output, 0o600); } catch (_) {}
  console.log(`Token guardado localmente en ${output}. No se ha mostrado en pantalla.`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
