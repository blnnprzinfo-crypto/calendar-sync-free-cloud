'use strict';

const { createSign } = require('node:crypto');

const DEFAULT_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function getCalendarScope() {
  return process.env.GOOGLE_CALENDAR_SCOPE || DEFAULT_CALENDAR_SCOPE;
}

function hasOAuthConfig() {
  return !!(
    process.env.GOOGLE_CALENDAR_CLIENT_ID &&
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  );
}

function hasServiceAccountConfig() {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

function getAuthMode() {
  const mode = String(process.env.GOOGLE_CALENDAR_AUTH_MODE || 'auto').toLowerCase();
  if (mode === 'oauth' || mode === 'service_account') return mode;
  if (hasOAuthConfig()) return 'oauth';
  if (hasServiceAccountConfig()) return 'service_account';
  return 'none';
}

function validateConfig() {
  const mode = getAuthMode();
  const missing = [];

  if (mode === 'oauth') {
    if (!process.env.GOOGLE_CALENDAR_CLIENT_ID) missing.push('GOOGLE_CALENDAR_CLIENT_ID');
    if (!process.env.GOOGLE_CALENDAR_CLIENT_SECRET) missing.push('GOOGLE_CALENDAR_CLIENT_SECRET');
    if (!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) missing.push('GOOGLE_CALENDAR_REFRESH_TOKEN');
  } else if (mode === 'service_account') {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    if (!process.env.GOOGLE_PRIVATE_KEY) missing.push('GOOGLE_PRIVATE_KEY');
  } else {
    missing.push('GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN o GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY');
  }

  return { ok: missing.length === 0, missing, mode };
}

function buildServiceAccountJwt(scopeOverride = null) {
  const now = Math.floor(Date.now() / 1000);
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    sub: email,
    scope: scopeOverride || getCalendarScope(),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const data = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(data);
  const sig = sign.sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

async function getServiceAccountToken(scopeOverride = null) {
  const jwt = buildServiceAccountJwt(scopeOverride);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Calendar auth service_account failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

async function getOAuthToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Calendar auth oauth failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

async function getAccessToken() {
  const validation = validateConfig();
  if (!validation.ok) {
    const err = new Error(`Configuracion Google Calendar incompleta: ${validation.missing.join(', ')}`);
    err.code = 'GOOGLE_CALENDAR_CONFIG_INCOMPLETA';
    err.missing = validation.missing;
    throw err;
  }

  if (validation.mode === 'oauth') return getOAuthToken();
  return getServiceAccountToken();
}

/**
 * Token con scope arbitrario (p.ej. Drive) — solo service_account.
 * OAuth de usuario tiene los scopes fijados al emitir el refresh_token.
 */
async function getAccessTokenForScope(scope) {
  const validation = validateConfig();
  if (!validation.ok || validation.mode !== 'service_account') {
    const err = new Error('getAccessTokenForScope requiere modo service_account configurado');
    err.code = 'GOOGLE_SCOPE_TOKEN_NO_DISPONIBLE';
    throw err;
  }
  return getServiceAccountToken(scope);
}

module.exports = {
  CALENDAR_SCOPE: DEFAULT_CALENDAR_SCOPE,
  getCalendarScope,
  getAuthMode,
  validateConfig,
  getAccessToken,
  getAccessTokenForScope,
  _private: {
    buildServiceAccountJwt,
  },
};
