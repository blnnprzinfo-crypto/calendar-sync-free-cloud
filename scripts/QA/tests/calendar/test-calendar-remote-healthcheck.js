'use strict';
process.env.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'test-owner/test-repo';
const assert = require('node:assert/strict');
const { evaluateRunHealth } = require('../../../../src/services/githubActionsStatusService');
const { readLeaseState } = require('../../../../src/services/calendarSyncRemoteLease');
const { pingIcloud } = require('../../../../src/services/icloudCalDavService');
const { evaluateRemoteHealth } = require('../../../PRODUCTION/diagnostics/calendar-sync-remote-healthcheck');

async function run() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`OK ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }

  const now = Date.parse('2026-10-01T12:00:00Z');

  await test('evaluateRunHealth: sano con una ejecucion reciente y exitosa', () => {
    const runs = [{ created_at: '2026-10-01T11:58:00Z', status: 'completed', conclusion: 'success' }];
    const health = evaluateRunHealth(runs, { now, maxScheduleGapMinutes: 20 });
    assert.equal(health.ok, true);
    assert.deepEqual(health.reasons, []);
    assert.equal(health.latestConclusion, 'success');
  });

  await test('evaluateRunHealth: falla si la ultima ejecucion es demasiado vieja', () => {
    const runs = [{ created_at: '2026-10-01T11:00:00Z', status: 'completed', conclusion: 'success' }];
    const health = evaluateRunHealth(runs, { now, maxScheduleGapMinutes: 20 });
    assert.equal(health.ok, false);
    assert.match(health.reasons[0], /sin ejecuciones recientes/);
  });

  await test('evaluateRunHealth: falla si la ultima ejecucion completada no fue exitosa', () => {
    const runs = [{ created_at: '2026-10-01T11:59:00Z', status: 'completed', conclusion: 'failure' }];
    const health = evaluateRunHealth(runs, { now, maxScheduleGapMinutes: 20 });
    assert.equal(health.ok, false);
    assert.match(health.reasons[0], /termino en 'failure'/);
  });

  await test('evaluateRunHealth: detecta un run en curso', () => {
    const runs = [
      { created_at: '2026-10-01T11:59:00Z', status: 'in_progress', conclusion: null },
      { created_at: '2026-10-01T11:00:00Z', status: 'completed', conclusion: 'success' },
    ];
    const health = evaluateRunHealth(runs, { now, maxScheduleGapMinutes: 20 });
    assert.equal(health.inProgress, true);
  });

  await test('evaluateRunHealth: sin runs registrados', () => {
    const health = evaluateRunHealth([], { now });
    assert.equal(health.ok, false);
    assert.match(health.reasons[0], /no hay runs registrados/);
  });

  await test('readLeaseState: lease libre (expiresAt en el pasado)', async () => {
    const event = { etag: 'e1', extendedProperties: { private: {
      belenciagaCalendarSyncOwner: 'writer-one:abc', belenciagaCalendarSyncExpiresAt: '2000-01-01T00:00:00.000Z',
    } } };
    const request = async method => { assert.equal(method, 'GET'); return event; };
    const state = await readLeaseState({ calendarId: 'lock-calendar', token: 'tok', request });
    assert.equal(state.exists, true);
    assert.equal(state.isClaimed, false);
  });

  await test('readLeaseState: lease reclamado (expiresAt en el futuro)', async () => {
    const future = new Date(Date.now() + 500_000).toISOString();
    const event = { etag: 'e1', extendedProperties: { private: {
      belenciagaCalendarSyncOwner: 'writer-one:abc', belenciagaCalendarSyncExpiresAt: future,
    } } };
    const request = async () => event;
    const state = await readLeaseState({ calendarId: 'lock-calendar', token: 'tok', request });
    assert.equal(state.isClaimed, true);
    assert.equal(state.owner, 'writer-one:abc');
  });

  await test('readLeaseState: no existe el evento de lease', async () => {
    const request = async () => { const error = new Error('not found'); error.status = 404; throw error; };
    const state = await readLeaseState({ calendarId: 'lock-calendar', token: 'tok', request });
    assert.deepEqual(state, { exists: false, owner: null, expiresAt: null, expiresAtMs: 0, isClaimed: false });
  });

  await test('pingIcloud: responde ok cuando el PROPFIND tiene exito', async () => {
    const caldavRequest = async (method, url) => { assert.equal(method, 'PROPFIND'); assert.equal(url, 'https://icloud.test/'); return '<multistatus/>'; };
    const result = await pingIcloud({ caldavRequest, baseUrl: 'https://icloud.test/' });
    assert.deepEqual(result, { ok: true });
  });

  await test('pingIcloud: propaga el error si las credenciales fallan', async () => {
    const caldavRequest = async () => { const error = new Error('iCloud CalDAV PROPFIND failed (401)'); error.status = 401; throw error; };
    await assert.rejects(() => pingIcloud({ caldavRequest, baseUrl: 'https://icloud.test/' }), /401/);
  });

  await test('evaluateRemoteHealth: todo sano', async () => {
    const result = await evaluateRemoteHealth({
      now,
      fetchWorkflowRuns: async () => [{ created_at: '2026-10-01T11:58:00Z', status: 'completed', conclusion: 'success' }],
      readLeaseState: async () => ({ exists: true, owner: null, expiresAt: null, expiresAtMs: 0, isClaimed: false }),
      pingIcloud: async () => ({ ok: true }),
    });
    assert.deepEqual(result, { ok: true, failures: [] });
  });

  await test('evaluateRemoteHealth: reporta fallo combinado de iCloud y lease atascado', async () => {
    const result = await evaluateRemoteHealth({
      now,
      fetchWorkflowRuns: async () => [{ created_at: '2026-10-01T11:58:00Z', status: 'completed', conclusion: 'success' }],
      readLeaseState: async () => ({ exists: true, owner: 'writer-one:abc', expiresAt: '2026-10-01T12:30:00.000Z', expiresAtMs: now + 1_800_000, isClaimed: true }),
      pingIcloud: async () => { throw new Error('iCloud CalDAV PROPFIND failed (401)'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures.find(f => f.startsWith('lease')), /lease reclamado/);
    assert.match(result.failures.find(f => f.startsWith('icloud')), /401/);
  });

  await test('evaluateRemoteHealth: fallo simulado no llama a ningun chequeo real', async () => {
    let called = false;
    const result = await evaluateRemoteHealth({
      simulateFailure: true,
      fetchWorkflowRuns: async () => { called = true; return []; },
      readLeaseState: async () => { called = true; },
      pingIcloud: async () => { called = true; },
    });
    assert.equal(result.ok, false);
    assert.match(result.failures[0], /simulado/);
    assert.equal(called, false);
  });

  console.log(`\nTotal: ${passed + failed} | OK: ${passed} | FAIL: ${failed}`);
  if (failed) process.exitCode = 1;
}

run();
