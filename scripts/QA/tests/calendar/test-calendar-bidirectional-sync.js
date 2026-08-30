'use strict';

const assert = require('node:assert/strict');
const service = require('../../../../src/services/calendarBidirectionalSyncService');

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

function appleEvent(overrides = {}) {
  return {
    uid: 'apple-1',
    sourceKey: 'source-1',
    fingerprint: 'apple-fp-1',
    summary: 'Cita prueba',
    description: 'Linea 1',
    location: 'Estudio',
    status: '',
    lastModified: '20260810T100000Z',
    start: { dateTime: '2026-08-20T10:00:00+02:00', timeZone: 'Europe/Madrid' },
    end: { dateTime: '2026-08-20T12:00:00+02:00', timeZone: 'Europe/Madrid' },
    recurrence: [],
    calendarName: 'tatuajes',
    href: 'https://icloud.test/cal/apple-1.ics',
    etag: 'etag-1',
    ...overrides,
  };
}

function googleEvent(overrides = {}) {
  return {
    id: 'google-1',
    summary: 'Cita prueba',
    description: 'Linea 1',
    location: 'Estudio',
    status: 'confirmed',
    updated: '2026-08-10T11:00:00Z',
    start: { dateTime: '2026-08-20T10:00:00+02:00', timeZone: 'Europe/Madrid' },
    end: { dateTime: '2026-08-20T12:00:00+02:00', timeZone: 'Europe/Madrid' },
    recurrence: [],
    extendedProperties: { private: {} },
    ...overrides,
  };
}

async function run() {
  await test('lee el mapa de cuatro calendarios', () => {
    const old = process.env.CALENDAR_SYNC_MAP_JSON;
    process.env.CALENDAR_SYNC_MAP_JSON = JSON.stringify({ tatuajes: 'g1', Trabajo: 'g2', 'uni 🤓': 'g3', 'gym 🦾': 'g4' });
    try { assert.equal(service.getCalendarMap().length, 4); }
    finally { process.env.CALENDAR_SYNC_MAP_JSON = old; }
  });

  await test('cloud puede exigir exactamente siete mapeos', () => {
    const oldMap = process.env.CALENDAR_SYNC_MAP_JSON;
    const oldCount = process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT;
    process.env.CALENDAR_SYNC_MAP_JSON = JSON.stringify({ uno: 'g1' });
    process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT = '7';
    try { assert.throws(() => service.getCalendarMap(), /se esperaban 7/); }
    finally {
      process.env.CALENDAR_SYNC_MAP_JSON = oldMap;
      process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT = oldCount;
    }
  });

  await test('la allowlist estricta rechaza cualquier calendario no autorizado', () => {
    const names = [
      'CALENDAR_SYNC_MAP_JSON', 'CALENDAR_SYNC_EXPECTED_MAPPING_COUNT',
      'CALENDAR_SYNC_ENFORCE_ALLOWLIST', 'CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON',
      'CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON',
    ];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.CALENDAR_SYNC_MAP_JSON = JSON.stringify({ 'SYNC-TEST-iCloud': 'google-test', Trabajo: 'google-real' });
    process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT = '2';
    process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST = 'true';
    process.env.CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON = JSON.stringify(['SYNC-TEST-iCloud']);
    process.env.CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON = JSON.stringify(['google-test']);
    try { assert.throws(() => service.getCalendarMap(), /fuera de la allowlist/); }
    finally {
      for (const name of names) {
        if (old[name] === undefined) delete process.env[name];
        else process.env[name] = old[name];
      }
    }
  });

  await test('la allowlist estricta acepta exclusivamente el par desechable', () => {
    const names = [
      'CALENDAR_SYNC_MAP_JSON', 'CALENDAR_SYNC_EXPECTED_MAPPING_COUNT',
      'CALENDAR_SYNC_ENFORCE_ALLOWLIST', 'CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON',
      'CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON',
    ];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.CALENDAR_SYNC_MAP_JSON = JSON.stringify({ 'SYNC-TEST-iCloud': 'google-test' });
    process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT = '1';
    process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST = 'true';
    process.env.CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON = JSON.stringify(['sync-test-icloud']);
    process.env.CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON = JSON.stringify(['google-test']);
    try { assert.equal(service.getCalendarMap().length, 1); }
    finally {
      for (const name of names) {
        if (old[name] === undefined) delete process.env[name];
        else process.env[name] = old[name];
      }
    }
  });

  await test('serializa un evento Google como ICS valido', () => {
    const ics = service.googleEventToIcs(googleEvent({ summary: 'A, B; C' }), 'uid-1');
    assert.match(ics, /BEGIN:VEVENT/);
    assert.match(ics, /UID:uid-1/);
    assert.match(ics, /SUMMARY:A\\, B\\; C/);
    assert.match(ics, /DTSTART:20260820T080000Z/);
  });

  await test('anade zona horaria a recurrencias iCloud que llegan en UTC', () => {
    const event = appleEvent({
      start: { dateTime: '2026-11-12T09:00:00.000Z' },
      end: { dateTime: '2026-11-12T10:00:00.000Z' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
    });
    const body = service._private.buildGoogleFromIcloud(event);
    assert.equal(body.start.timeZone, 'Europe/Madrid');
    assert.equal(body.end.timeZone, 'Europe/Madrid');
  });

  await test('el cambio mas reciente gana un conflicto', () => {
    assert.equal(service.selectConflictWinner(appleEvent(), googleEvent()), 'google');
    assert.equal(service.selectConflictWinner(appleEvent({ lastModified: '20260810T120000Z' }), googleEvent()), 'icloud');
  });

  await test('icloud_wins existe pero no es la politica inicial', () => {
    assert.equal(service.getConflictPolicy(), 'newest_wins');
    assert.equal(service.selectConflictWinner(appleEvent(), googleEvent(), 'icloud_wins'), 'icloud');
  });

  await test('rechaza cualquier intento de activar borrados', async () => {
    const old = process.env.CALENDAR_SYNC_PROPAGATE_DELETES;
    process.env.CALENDAR_SYNC_PROPAGATE_DELETES = 'true';
    try {
      await assert.rejects(() => service.syncBidirectional({ dryRun: true }), /nunca propaga borrados/);
    } finally {
      process.env.CALENDAR_SYNC_PROPAGATE_DELETES = old;
    }
  });

  await test('crea en Google lo que solo existe en iCloud', async () => {
    const request = async method => method === 'GET' ? { items: [] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [appleEvent()], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    });
    assert.deepEqual(operations.map(item => item.type), ['create_google']);
  });

  await test('crea en iCloud lo que solo existe en Google', async () => {
    const request = async method => method === 'GET' ? { items: [googleEvent()] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    });
    assert.deepEqual(operations.map(item => item.type), ['create_icloud']);
  });

  await test('por defecto conserva una copia Google enlazada cuyo original no aparece', async () => {
    const uid = 'icloud-missing-1';
    const calendar = { name: 'tatuajes', url: 'https://icloud.test/cal/' };
    const linked = googleEvent({ extendedProperties: { private: {
      belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaSourceKey: service._private.sourceKey(calendar.url, uid),
      belenciagaIcloudUid: uid,
      belenciagaIcloudCalendar: 'tatuajes',
    } } });
    const request = async method => method === 'GET' ? { items: [linked] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' }, calendar,
      icloudEvents: [], token: 'token', start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, request,
    });
    assert.deepEqual(operations, []);
  });

  await test('dry-run detecta solo una copia Google gestionada y confirmada como huerfana', async () => {
    const uid = 'icloud-missing-2';
    const calendar = { name: 'tatuajes', url: 'https://icloud.test/cal/' };
    const linked = googleEvent({ extendedProperties: { private: {
      belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaSourceKey: service._private.sourceKey(calendar.url, uid),
      belenciagaIcloudUid: uid,
      belenciagaIcloudCalendar: 'tatuajes',
    } } });
    const request = async method => method === 'GET' ? { items: [linked] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' }, calendar,
      icloudEvents: [], token: 'token', start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, request, pruneManagedGoogleOrphans: true,
      icloudObjectExists: async () => false,
    });
    assert.deepEqual(operations.map(item => item.type), ['delete_google_orphan']);
  });

  await test('apply borra en Google la copia gestionada huerfana y nunca escribe en iCloud', async () => {
    const uid = 'icloud-missing-3';
    const calendar = { name: 'tatuajes', url: 'https://icloud.test/cal/' };
    const linked = googleEvent({ id: 'orphan-3', extendedProperties: { private: {
      belenciagaSource: 'google-calendar-bidirectional',
      belenciagaSourceKey: service._private.sourceKey(calendar.url, uid),
      belenciagaIcloudUid: uid,
      belenciagaIcloudCalendar: 'tatuajes',
    } } });
    const calls = [];
    const request = async (method, path) => {
      calls.push({ method, path });
      return method === 'GET' ? { items: [linked] } : {};
    };
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' }, calendar,
      icloudEvents: [], token: 'token', start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: false, request, pruneManagedGoogleOrphans: true,
      icloudObjectExists: async () => false,
    });
    assert.deepEqual(operations.map(item => item.type), ['delete_google_orphan']);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
    assert.match(calls.find(call => call.method === 'DELETE').path, /orphan-3/);
  });

  await test('no borra un evento con metadatos incompletos o de otro calendario', async () => {
    const linked = googleEvent({ extendedProperties: { private: {
      belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaSourceKey: 'no-es-la-clave-del-uid',
      belenciagaIcloudUid: 'uid-ajeno',
      belenciagaIcloudCalendar: 'Trabajo',
    } } });
    const request = async method => method === 'GET' ? { items: [linked] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [], token: 'token', start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, request, pruneManagedGoogleOrphans: true,
      icloudObjectExists: async () => false,
    });
    assert.deepEqual(operations, []);
  });

  await test('conserva una copia canonica y detecta solo la copia Google repetida', async () => {
    const apple = appleEvent();
    const calendar = { name: 'tatuajes', url: 'https://icloud.test/cal/' };
    const props = {
      belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaSourceKey: apple.sourceKey,
      belenciagaIcloudUid: apple.uid,
      belenciagaIcloudCalendar: 'tatuajes',
      belenciagaIcloudFingerprint: apple.fingerprint,
      belenciagaGoogleFingerprint: service.contentFingerprint(googleEvent()),
    };
    // Para esta prueba la clave real del evento debe corresponder con URL+UID.
    apple.sourceKey = service._private.sourceKey(calendar.url, apple.uid);
    props.belenciagaSourceKey = apple.sourceKey;
    const first = googleEvent({ id: 'canonical', extendedProperties: { private: props } });
    const second = googleEvent({ id: 'duplicate', extendedProperties: { private: props } });
    const request = async method => method === 'GET' ? { items: [first, second] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' }, calendar,
      icloudEvents: [apple], token: 'token', start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, request, pruneManagedGoogleOrphans: true,
      icloudObjectExists: async () => true,
    });
    assert.deepEqual(operations.map(item => item.type), ['skip_unchanged', 'delete_google_duplicate']);
  });

  await test('enlaza copias existentes sin duplicarlas', async () => {
    const request = async method => method === 'GET' ? { items: [googleEvent()] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [appleEvent()], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    });
    assert.deepEqual(operations.map(item => item.type), ['link_existing']);
  });

  await test('detecta una edicion manual en Google', async () => {
    const apple = appleEvent();
    const baseline = service.contentFingerprint(apple);
    const google = googleEvent({
      summary: 'Editada en Google',
      created: '2026-08-10T10:59:59Z',
      updated: '2026-08-10T11:00:00Z',
      extendedProperties: { private: {
        belenciagaSourceKey: apple.sourceKey,
        belenciagaIcloudFingerprint: apple.fingerprint,
        belenciagaGoogleFingerprint: baseline,
      } },
    });
    const request = async method => method === 'GET' ? { items: [google] } : {};
    const operations = await service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [apple], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    });
    assert.deepEqual(operations.map(item => item.type), ['update_icloud']);
  });

  await test('la misma hora en UTC y en Europe/Madrid da la misma huella', () => {
    // iCloud devuelve UTC y Google devuelve el desfase local. Es el mismo
    // instante, asi que la huella tiene que coincidir.
    const utc = appleEvent({
      start: { dateTime: '2026-08-20T08:00:00.000Z' },
      end: { dateTime: '2026-08-20T10:00:00.000Z' },
    });
    const local = googleEvent({
      start: { dateTime: '2026-08-20T10:00:00+02:00', timeZone: 'Europe/Madrid' },
      end: { dateTime: '2026-08-20T12:00:00+02:00', timeZone: 'Europe/Madrid' },
    });
    assert.equal(service.contentFingerprint(utc), service.contentFingerprint(local));
  });

  await test('no reescribe nada cuando solo cambia el formato de la hora', () => {
    // Regresion: con huellas sin normalizar, cada pasada veia un cambio
    // inexistente y Apple y Google se reescribian en bucle.
    const apple = appleEvent({
      start: { dateTime: '2026-08-20T08:00:00.000Z' },
      end: { dateTime: '2026-08-20T10:00:00.000Z' },
    });
    const google = googleEvent({
      extendedProperties: { private: {
        belenciagaSourceKey: apple.sourceKey,
        belenciagaIcloudFingerprint: apple.fingerprint,
        belenciagaGoogleFingerprint: service.contentFingerprint(apple),
      } },
    });
    const request = async method => method === 'GET' ? { items: [google] } : {};
    return service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [apple], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    }).then(operations => {
      assert.deepEqual(operations.map(item => item.type), ['skip_unchanged']);
    });
  });

  await test('acepta las huellas guardadas antes del arreglo horario', () => {
    // Los eventos ya sincronizados llevan la huella vieja: reconocerla evita
    // una reescritura masiva la primera vez que corre el codigo nuevo.
    const apple = appleEvent();
    const google = googleEvent({
      extendedProperties: { private: {
        belenciagaSourceKey: apple.sourceKey,
        belenciagaIcloudFingerprint: apple.fingerprint,
        belenciagaGoogleFingerprint: service._private.legacyContentFingerprint(googleEvent()),
      } },
    });
    const request = async method => method === 'GET' ? { items: [google] } : {};
    return service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [apple], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    }).then(operations => {
      assert.deepEqual(operations.map(item => item.type), ['skip_unchanged']);
    });
  });

  await test('cada operacion lleva la clave de sincronizacion', () => {
    // El watchdog necesita identificar el evento entre pasada y pasada.
    const apple = appleEvent();
    const request = async method => method === 'GET' ? { items: [] } : {};
    return service._private.syncCalendarPair({
      mapping: { icloudName: 'tatuajes', googleCalendarId: 'g1' },
      calendar: { name: 'tatuajes', url: 'https://icloud.test/cal/' },
      icloudEvents: [apple], token: 'token',
      start: new Date('2026-08-01Z'), end: new Date('2026-09-01Z'),
      dryRun: true, propagateDeletes: false, request,
    }).then(operations => {
      assert.equal(operations[0].type, 'create_google');
      assert.equal(operations[0].sourceKey, apple.sourceKey);
    });
  });

  console.log(`\nTotal: ${passed + failed} | OK: ${passed} | FAIL: ${failed}`);
  if (failed) process.exit(1);
}

run().catch(error => { console.error(error); process.exit(1); });
