'use strict';

const assert = require('node:assert/strict');
const { importAules } = require('../../../../src/services/aulesIcsImportService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function feed({ start = '20261019T235900', summary = 'Práctica 3', description = 'Entrega final' } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:aules-1',
    `SUMMARY:${summary}`, `DESCRIPTION:${description}`, `DTSTART:${start}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function response(text, { status = 200, contentType = 'text/calendar' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' },
    text: async () => text,
  };
}

function withEnv(fn) {
  const names = [
    'CALENDAR_SYNC_MAP_JSON', 'AULES_TARGET_ICLOUD_NAME',
    'CALENDAR_SYNC_ENFORCE_ALLOWLIST', 'CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON',
    'CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON',
  ];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.CALENDAR_SYNC_MAP_JSON = JSON.stringify({ 'uni 🤓': 'google-uni', Trabajo: 'google-work' });
  delete process.env.AULES_TARGET_ICLOUD_NAME;
  return Promise.resolve().then(fn).finally(() => {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  });
}

async function run() {
  await test('Aules crea todo el dia transparente con prefijo', () => withEnv(async () => {
    const calls = [];
    const result = await importAules({
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response(feed()),
      googleRequestOverride: async (method, path, token, body) => {
        calls.push({ method, path, token, body });
        return method === 'GET' ? { items: [] } : { id: 'created-1' };
      },
    });
    assert.deepEqual({ created: result.created, updated: result.updated }, { created: 1, updated: 0 });
    const body = calls.find(call => call.method === 'POST').body;
    assert.equal(body.summary, '📚 Práctica 3');
    assert.deepEqual(body.start, { date: '2026-10-19' });
    assert.deepEqual(body.end, { date: '2026-10-20' });
    assert.equal(body.transparency, 'transparent');
    assert.match(body.description, /Fecha\/hora límite original: 2026-10-19 23:59:00/);
  }));

  await test('convierte a Madrid una entrega UTC cercana a medianoche', () => withEnv(async () => {
    const calls = [];
    await importAules({
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response(feed({ start: '20261019T235900Z' })),
      googleRequestOverride: async (method, path, token, body) => {
        calls.push({ method, body });
        return method === 'GET' ? { items: [] } : { id: 'created-utc' };
      },
    });
    const body = calls.find(call => call.method === 'POST').body;
    assert.deepEqual(body.start, { date: '2026-10-20' });
    assert.deepEqual(body.end, { date: '2026-10-21' });
    assert.match(body.description, /Fecha\/hora límite original: 2026-10-19 23:59:00 UTC/);
  }));

  await test('dos ejecuciones no duplican y un cambio actualiza', () => withEnv(async () => {
    const stored = [];
    const methods = [];
    const request = async (method, path, token, body) => {
      methods.push(method);
      if (method === 'GET') return { items: stored };
      if (method === 'POST') stored.push({ id: 'google-1', ...body });
      if (method === 'PATCH') Object.assign(stored[0], body);
      return stored[0];
    };
    const common = { url: 'https://private.invalid/feed', tokenOverride: 'token', googleRequestOverride: request };
    await importAules({ ...common, fetchOverride: async () => response(feed()) });
    stored[0].extendedProperties.private.belenciagaSourceKey = 'bridge-key';
    const same = await importAules({ ...common, fetchOverride: async () => response(feed()) });
    const changed = await importAules({ ...common, fetchOverride: async () => response(feed({ start: '20261020T235900' })) });
    assert.equal(stored.length, 1);
    assert.equal(same.unchanged, 1);
    assert.equal(changed.updated, 1);
    assert.equal(methods.filter(method => method === 'POST').length, 1);
    assert.equal(methods.filter(method => method === 'PATCH').length, 1);
    assert.equal(stored[0].extendedProperties.private.belenciagaSourceKey, 'bridge-key');
  }));

  await test('autocorrige una entrega Aules cambiada a opaque', () => withEnv(async () => {
    const stored = [];
    const methods = [];
    const request = async (method, path, token, body) => {
      methods.push(method);
      if (method === 'GET') return { items: stored };
      if (method === 'POST') stored.push({ id: 'google-1', ...body });
      if (method === 'PATCH') Object.assign(stored[0], body);
      return stored[0];
    };
    const common = {
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response(feed()), googleRequestOverride: request,
    };
    await importAules(common);
    stored[0].transparency = 'opaque';
    const repaired = await importAules(common);
    assert.equal(stored.length, 1);
    assert.equal(repaired.updated, 1);
    assert.equal(methods.filter(method => method === 'POST').length, 1);
    assert.equal(methods.filter(method => method === 'PATCH').length, 1);
    assert.equal(stored[0].transparency, 'transparent');
  }));

  await test('allowlist invalida falla antes de mutar Google', () => withEnv(async () => {
    process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST = 'true';
    process.env.CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON = JSON.stringify(['Trabajo']);
    process.env.CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON = JSON.stringify(['google-work']);
    let googleCalls = 0;
    await assert.rejects(() => importAules({
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response(feed()),
      googleRequestOverride: async () => { googleCalls++; return {}; },
    }), /fuera de la allowlist/);
    assert.equal(googleCalls, 0);
  }));

  await test('feed sin eventos no borra nada', () => withEnv(async () => {
    const methods = [];
    const result = await importAules({
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'),
      googleRequestOverride: async method => { methods.push(method); return { items: [] }; },
    });
    assert.equal(result.source, 0);
    assert.deepEqual(methods, ['GET']);
  }));

  await test('URL ausente es no-op limpio', async () => {
    const old = process.env.AULES_ICS_URL;
    delete process.env.AULES_ICS_URL;
    try {
      const result = await importAules({ fetchOverride: async () => { throw new Error('no debe descargar'); } });
      assert.equal(result.skipped, 'missing_url');
    } finally {
      if (old === undefined) delete process.env.AULES_ICS_URL;
      else process.env.AULES_ICS_URL = old;
    }
  });

  await test('feed invalido no muta Google', () => withEnv(async () => {
    let googleCalls = 0;
    await assert.rejects(() => importAules({
      url: 'https://private.invalid/feed', tokenOverride: 'token',
      fetchOverride: async () => response('<html>login</html>', { contentType: 'text/html' }),
      googleRequestOverride: async () => { googleCalls++; return {}; },
    }), /HTML/);
    assert.equal(googleCalls, 0);
  }));

  console.log(`\nTotal Aules: ${passed + failed} | OK: ${passed} | FAIL: ${failed}`);
  if (failed) process.exit(1);
}

run().catch(error => { console.error(error); process.exit(1); });
