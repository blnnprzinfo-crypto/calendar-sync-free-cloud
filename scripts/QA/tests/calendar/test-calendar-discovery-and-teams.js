'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseIcsEvents } = require('../../../../src/services/calendarIcsEventParser');
const bridge = require('../../../../src/services/calendarBidirectionalSyncService');
const discovery = require('../../../../src/services/calendarDiscoveryService');
const teams = require('../../../../src/services/teamsUniversityCalendarSyncService');
const icloud = require('../../../../src/services/icloudCalDavService');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`OK ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

function ics(extra = '', meta = {}) {
  return parseIcsEvents(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261001T080000Z\r\nDTEND:20261001T090000Z\r\nSUMMARY:TFG\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`, {
    calendarName: 'uni 🤓', calendarUrl: 'https://icloud.test/uni/', ...meta,
  })[0];
}

function plan(overrides = {}) {
  return discovery.buildDiscoveryPlan({
    icloudCalendars: [{ name: 'uni 🤓', url: 'i-uni' }],
    googleCalendars: [{ summary: 'uni 🤓', id: 'g-uni', accessRole: 'owner' }],
    authMode: 'oauth', createMissing: false, ...overrides,
  });
}

async function run() {
  await test('ICS TRANSPARENT se convierte en libre', () => assert.equal(ics('TRANSP:TRANSPARENT\r\n').transparency, 'transparent'));
  await test('ICS sin TRANSP se considera ocupado', () => assert.equal(ics().transparency, 'opaque'));
  await test('Google libre se serializa como TRANSPARENT', () => {
    const value = bridge.googleEventToIcs({ summary: 'x', start: { date: '2026-10-01' }, end: { date: '2026-10-02' }, transparency: 'transparent' }, 'u');
    assert.match(value, /TRANSP:TRANSPARENT/);
  });
  await test('Google ocupado se serializa como OPAQUE', () => {
    const value = bridge.googleEventToIcs({ summary: 'x', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } }, 'u');
    assert.match(value, /TRANSP:OPAQUE/);
  });
  await test('la huella ignora ETag y LAST-MODIFIED', () => {
    const a = ics('LAST-MODIFIED:20260101T000000Z\r\n', { etag: 'a' });
    const b = ics('LAST-MODIFIED:20260901T000000Z\r\n', { etag: 'b' });
    assert.equal(a.fingerprint, b.fingerprint);
  });
  await test('la huella detecta cambios Libre/Ocupado', () => assert.notEqual(ics().fingerprint, ics('TRANSP:TRANSPARENT\r\n').fingerprint));
  await test('propiedades ICS desconocidas sobreviven una reescritura', () => {
    const apple = ics('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n');
    const value = bridge.googleEventToIcs({ summary: 'x', start: apple.start, end: apple.end }, apple.uid, [], apple.preservedProperties);
    assert.match(value, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  });
  await test('autodescubrimiento empareja un nombre unico editable', () => assert.deepEqual(plan().mappings.map(x => x.googleCalendarId), ['g-uni']));
  await test('override manual permite nombres distintos', () => {
    const result = plan({
      icloudCalendars: [{ name: 'Universidad', url: 'i' }],
      googleCalendars: [{ summary: 'uni 🤓', id: 'g', accessRole: 'owner' }],
      overrides: { Universidad: 'g' },
    });
    assert.equal(result.mappings[0].source, 'manual');
  });
  await test('autodescubrimiento maneja varios calendarios', () => {
    const result = plan({
      icloudCalendars: [{ name: 'uni 🤓', url: 'i1' }, { name: 'Personal', url: 'i2' }],
      googleCalendars: [
        { summary: 'uni 🤓', id: 'g1', accessRole: 'owner' },
        { summary: 'Personal', id: 'g2', accessRole: 'writer' },
      ],
    });
    assert.deepEqual(result.mappings.map(x => x.googleCalendarId).sort(), ['g1', 'g2']);
  });
  await test('nombres ambiguos fallan cerrados', () => {
    const result = plan({ googleCalendars: [
      { summary: 'uni 🤓', id: 'a', accessRole: 'owner' },
      { summary: 'uni 🤓', id: 'b', accessRole: 'writer' },
    ] });
    assert.ok(result.diagnostics.some(x => x.code === 'ambiguous_same_name' && x.severity === 'error'));
    assert.equal(result.mappings.length, 0);
  });
  await test('mismo nombre de solo lectura no crea un duplicado', () => {
    const result = plan({ googleCalendars: [{ summary: 'uni 🤓', id: 'r', accessRole: 'reader' }], createMissing: true });
    assert.equal(result.createGoogle.length, 0);
    assert.ok(result.diagnostics.some(x => x.code === 'same_name_read_only'));
  });
  await test('calendarios tecnicos quedan fuera', () => {
    const result = plan({
      icloudCalendars: [{ name: 'SYNC-LOCK-TECHNICAL', url: 'lock' }],
      googleCalendars: [{ summary: 'SYNC-LOCK-TECHNICAL', id: 'lock-g', accessRole: 'owner' }],
    });
    assert.equal(result.mappings.length + result.createGoogle.length + result.createIcloud.length, 0);
  });
  await test('denylist excluye por nombre', () => {
    const result = plan({ denylist: ['uni 🤓'] });
    assert.equal(result.mappings.length, 0);
  });
  await test('OAuth puede planificar un calendario Google ausente', () => {
    const result = plan({ googleCalendars: [], createMissing: true, authMode: 'oauth' });
    assert.equal(result.createGoogle.length, 1);
  });
  await test('service account no puede crear calendario Google del usuario', () => {
    const result = plan({ googleCalendars: [], createMissing: true, authMode: 'service_account' });
    assert.equal(result.createGoogle.length, 0);
    assert.ok(result.diagnostics.some(x => x.code === 'google_creation_requires_oauth'));
  });
  await test('creacion bidireccional usa Google OAuth y MKCALENDAR verificado', async () => {
    const names = ['CALENDAR_SYNC_AUTODISCOVERY', 'CALENDAR_SYNC_CREATE_MISSING_CALENDARS', 'GOOGLE_CALENDAR_AUTH_MODE', 'CALENDAR_SYNC_MAP_JSON'];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const oldCreate = icloud.createCalendar;
    process.env.CALENDAR_SYNC_AUTODISCOVERY = 'true';
    process.env.CALENDAR_SYNC_CREATE_MISSING_CALENDARS = 'true';
    process.env.GOOGLE_CALENDAR_AUTH_MODE = 'oauth';
    delete process.env.CALENDAR_SYNC_MAP_JSON;
    let mkcalendarCalls = 0;
    icloud.createCalendar = async ({ name }) => { mkcalendarCalls++; return { name, url: 'https://icloud.test/personal/' }; };
    const request = async (method, requestPath) => {
      if (method === 'GET' && requestPath.startsWith('/users/me/calendarList')) {
        return { items: [{ summary: 'Personal', id: 'g-personal', accessRole: 'owner' }] };
      }
      if (method === 'POST' && requestPath === '/calendars') return { id: 'g-uni' };
      throw new Error(`peticion inesperada ${method} ${requestPath}`);
    };
    try {
      const result = await bridge._private.resolveMappings({
        discoveredIcloud: [{ name: 'uni 🤓', url: 'https://icloud.test/uni/' }],
        token: 'token', request, dryRun: false,
      });
      assert.equal(result.mappings.length, 2);
      assert.equal(mkcalendarCalls, 1);
    } finally {
      icloud.createCalendar = oldCreate;
      for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];
    }
  });
  await test('evento gestionado fuera de ventana se localiza por sourceKey', async () => {
    let requested = '';
    const found = await bridge._private.findGoogleBySourceKey({
      token: 'x', calendarId: 'g', key: 'source-1',
      request: async (_method, requestPath) => {
        requested = requestPath;
        return { items: [{ id: 'existing', extendedProperties: { private: { belenciagaSourceKey: 'source-1' } } }] };
      },
    });
    assert.equal(found.id, 'existing');
    assert.match(requested, /privateExtendedProperty=belenciagaSourceKey%3Dsource-1/);
    assert.doesNotMatch(requested, /timeMin|timeMax/);
  });
  await test('carrera de ETag Google aborta la escritura iCloud', async () => {
    const apple = {
      uid: 'u', sourceKey: 'k', fingerprint: 'apple-new', legacyFingerprint: 'legacy', transparency: 'opaque',
      summary: 'A', description: '', location: '', start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
      recurrence: [], calendarName: 'uni 🤓', href: 'https://icloud.test/u.ics', etag: 'ia', lastModified: '20260101T000000Z',
    };
    const graph = {
      id: 'g1', etag: 'old', summary: 'B', description: '', location: '', status: 'confirmed', updated: '2026-09-01T00:00:00Z',
      start: { date: '2026-10-01' }, end: { date: '2026-10-02' }, recurrence: [],
      extendedProperties: { private: { belenciagaSourceKey: 'k', belenciagaIcloudFingerprint: 'old', belenciagaGoogleFingerprint: 'old' } },
    };
    const operations = await bridge._private.syncCalendarPair({
      mapping: { icloudName: 'uni 🤓', googleCalendarId: 'gc' }, calendar: { name: 'uni 🤓', url: 'https://icloud.test/' },
      icloudEvents: [apple], token: 'x', start: new Date('2026-01-01'), end: new Date('2027-01-01'), dryRun: false,
      request: async (_method, requestPath) => requestPath.includes('/events/g1') ? { ...graph, etag: 'new' } : { items: [graph] },
    });
    assert.ok(operations.some(x => x.type === 'skip_google_changed_during_run'));
    assert.ok(!operations.some(x => x.type === 'update_icloud'));
  });
  await test('RRULE y EXDATE se conservan', () => {
    const event = ics('RRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20261002T080000Z\r\n');
    assert.deepEqual(event.recurrence, ['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261002T080000Z']);
  });
  await test('all-day conserva fechas sin convertir zona horaria', () => {
    const event = parseIcsEvents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')[0];
    assert.deepEqual(event.start, { date: '2026-10-01' });
  });
  await test('cambio Libre/Ocupado altera la huella Google', () => {
    const base = { summary: 'x', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } };
    assert.notEqual(bridge.contentFingerprint({ ...base, transparency: 'transparent' }), bridge.contentFingerprint({ ...base, transparency: 'opaque' }));
  });
  await test('todas las mutaciones Google de eventos desactivan emails', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../src/services/calendarBidirectionalSyncService.js'), 'utf8');
    const mutationPaths = [...source.matchAll(/request\('(PATCH|POST|DELETE)',\s*`([^`]+)`/g)]
      .filter(match => match[2].includes('/events'));
    assert.ok(mutationPaths.length > 0);
    for (const match of mutationPaths) assert.match(match[2], /sendUpdates=none/);
  });
  await test('Teams traduce libre a showAs free', () => {
    const result = teams._private.icloudToGraph({
      summary: 'TFG', description: '', location: '', transparency: 'transparent',
      start: { dateTime: '2026-10-01T10:00:00', timeZone: 'Europe/Madrid' },
      end: { dateTime: '2026-10-01T11:00:00', timeZone: 'Europe/Madrid' },
    }, {});
    assert.equal(result.showAs, 'free');
  });
  await test('Teams traduce showAs busy a ocupado', () => {
    assert.equal(teams._private.graphToPortable({ start: {}, end: {}, showAs: 'busy' }).transparency, 'opaque');
  });
  await test('metadatos Teams se recuperan sin usar titulos', () => {
    const props = teams._private.extensionPayload({ sourceKey: 'k', uid: 'u', icloudFingerprint: 'i', teamsFingerprint: 't' });
    assert.deepEqual(teams._private.extensionValues({ singleValueExtendedProperties: props }), {
      sourceKey: 'k', uid: 'u', icloudFingerprint: 'i', teamsFingerprint: 't',
    });
  });
  await test('Teams desactivado no solicita credenciales ni red', async () => {
    const old = process.env.TEAMS_UNIVERSITY_SYNC_ENABLED;
    delete process.env.TEAMS_UNIVERSITY_SYNC_ENABLED;
    try { assert.equal((await teams.syncUniversityTeams()).enabled, false); }
    finally { if (old !== undefined) process.env.TEAMS_UNIVERSITY_SYNC_ENABLED = old; }
  });
  console.log(`\nTotal: ${passed + failed} | OK: ${passed} | FAIL: ${failed}`);
  if (failed) process.exit(1);
}

run();
