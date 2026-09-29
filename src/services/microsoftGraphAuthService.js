'use strict';

async function getAccessToken() {
  const tenant = String(process.env.MICROSOFT_TENANT_ID || 'organizations').trim();
  const clientId = String(process.env.MICROSOFT_CLIENT_ID || '').trim();
  const refreshToken = String(process.env.MICROSOFT_REFRESH_TOKEN || '').trim();
  if (!clientId || !refreshToken) {
    throw new Error('Faltan MICROSOFT_CLIENT_ID o MICROSOFT_REFRESH_TOKEN.');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: String(process.env.MICROSOFT_SCOPES || 'offline_access Calendars.ReadWrite User.Read').trim(),
  });
  if (process.env.MICROSOFT_CLIENT_SECRET) params.set('client_secret', process.env.MICROSOFT_CLIENT_SECRET);
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Microsoft OAuth fallo (${response.status}): ${String(data.error || 'respuesta invalida')}`);
  }
  return data.access_token;
}

module.exports = { getAccessToken };
