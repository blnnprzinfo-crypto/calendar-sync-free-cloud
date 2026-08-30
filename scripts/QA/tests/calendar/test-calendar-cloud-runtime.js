'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRemoteLease } = require('../../../../src/services/calendarSyncRemoteLease');

async function run() {
  let event = null;
  let etag = 0;
  const request = async (method, path, token, body, headers = {}) => {
    assert.equal(token, 'fake-token');
    if (method === 'GET') {
      if (!event) { const error = new Error('not found'); error.status = 404; throw error; }
      return structuredClone(event);
    }
    if (method === 'POST') {
      if (event) { const error = new Error('conflict'); error.status = 409; throw error; }
      event = { ...structuredClone(body), etag: `etag-${++etag}` };
      return structuredClone(event);
    }
    if (method === 'PATCH') {
      if (headers['If-Match'] !== event.etag) { const error = new Error('precondition'); error.status = 412; throw error; }
      event = { ...structuredClone(body), etag: `etag-${++etag}` };
      return structuredClone(event);
    }
    throw new Error(`metodo inesperado ${method} ${path}`);
  };
  const options = { calendarId: 'lock-calendar', request, getAccessToken: async () => 'fake-token' };

  const missing = createRemoteLease({ ...options, writerId: 'writer-missing' });
  await assert.rejects(() => missing.acquire(), /evento de lease no existe/);

  const first = createRemoteLease({ ...options, writerId: 'writer-one', allowCreate: true });
  await first.acquire();
  assert.match(event.extendedProperties.private.belenciagaCalendarSyncOwner, /^writer-one:/);

  const second = createRemoteLease({ ...options, writerId: 'writer-two' });
  await assert.rejects(() => second.acquire(), /Lease ocupado/);

  await first.release();
  await second.acquire();
  assert.match(event.extendedProperties.private.belenciagaCalendarSyncOwner, /^writer-two:/);
  await second.release();

  console.log('OK lease remoto: exclusion, liberacion y relevo de escritor');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-health-'));
  try {
    const heartbeatPath = path.join(tempDir, 'heartbeat.json');
    fs.writeFileSync(heartbeatPath, JSON.stringify({ timestamp: new Date().toISOString(), status: 'ok', mode: 'watch' }));
    const health = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../../PRODUCTION/diagnostics/calendar-sync-healthcheck.js'),
    ], {
      encoding: 'utf8',
      env: { ...process.env, CALENDAR_SYNC_HEARTBEAT_PATH: heartbeatPath, CALENDAR_SYNC_HEARTBEAT_MAX_AGE_SECONDS: '180' },
    });
    assert.equal(health.status, 0, health.stderr);
    assert.match(health.stdout, /\[calendar-health\] OK/);
    console.log('OK healthcheck acepta un heartbeat reciente');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exit(1); });
