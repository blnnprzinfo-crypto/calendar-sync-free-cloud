'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const tenant = String(process.env.MICROSOFT_TENANT_ID || 'organizations').trim();
const clientId = String(process.env.MICROSOFT_CLIENT_ID || '').trim();
const scopes = String(process.env.MICROSOFT_SCOPES || 'offline_access Calendars.ReadWrite User.Read').trim();
const output = path.resolve(process.argv[2] || 'microsoft-refresh-token.txt');

async function main() {
  if (!clientId) throw new Error('Define MICROSOFT_CLIENT_ID para una aplicacion publica de Microsoft Entra.');
  const deviceResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: scopes }),
  });
  const device = await deviceResponse.json();
  if (!deviceResponse.ok) throw new Error(`No se pudo iniciar Device Code: ${device.error || deviceResponse.status}`);
  // El mensaje no contiene tokens; solo el codigo de consentimiento temporal.
  console.log(device.message);
  const interval = Math.max(5, Number(device.interval) || 5) * 1000;
  const deadline = Date.now() + Number(device.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.device_code,
      }),
    });
    const result = await response.json();
    if (response.ok && result.refresh_token) {
      fs.writeFileSync(output, `${result.refresh_token}\n`, { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(output, 0o600); } catch (_) {}
      console.log(`Token guardado localmente en ${output}. No se ha mostrado en pantalla.`);
      return;
    }
    if (!['authorization_pending', 'slow_down'].includes(result.error)) {
      throw new Error(`Microsoft OAuth fallo: ${result.error || response.status}`);
    }
  }
  throw new Error('El codigo de Microsoft ha caducado.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
