'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { listDeletionBackups, restoreFromDeletionBackup } = require('../../../../src/services/calendarDeletionBackup');

const digest = value => createHash('sha256').update(value).digest('hex');

function packBackupEvent({ id, summary = 'Cita de prueba', start = { date: '2026-09-20' }, payloadOverride } = {}) {
  const payload = payloadOverride || JSON.stringify({
    version: 1, href: 'https://icloud.test/cal/uid.ics', etag: 'apple-etag',
    sourceKey: 'source-key', googleCalendarId: 'g1', googleEventId: 'google-event',
    ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  });
  const packed = gzipSync(payload).toString('base64');
  const chunks = packed.match(/.{1,1000}/g);
  const props = {
    deletionBackup: 'v1', checksum: digest(payload), chunks: String(chunks.length),
    originalSummary: summary, originalStart: JSON.stringify(start), deletedAt: '2026-09-18T10:00:00.000Z',
  };
  chunks.forEach((chunk, index) => { props[`data${index}`] = chunk; });
  return { id, extendedProperties: { private: props } };
}

async function run() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`OK ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }

  await test('restaura un respaldo valido en iCloud con semantica create-only', async () => {
    const event = packBackupEvent({ id: 'de1abc' });
    const request = async (method, path) => {
      assert.equal(method, 'GET');
      assert.match(path, /\/events\/de1abc$/);
      return event;
    };
    const puts = [];
    const putIcloudObject = async args => { puts.push(args); return { ok: true }; };
    const restored = await restoreFromDeletionBackup({
      backupId: 'de1abc', calendarId: 'technical', token: 'tok', request, putIcloudObject,
    });
    assert.equal(restored.href, 'https://icloud.test/cal/uid.ics');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].url, 'https://icloud.test/cal/uid.ics');
    assert.equal(puts[0].createOnly, true);
    assert.match(puts[0].ics, /UID:uid/);
  });

  await test('rechaza un evento que no es un respaldo valido', async () => {
    const request = async () => ({ id: 'not-a-backup', extendedProperties: { private: {} } });
    await assert.rejects(
      () => restoreFromDeletionBackup({ backupId: 'x', calendarId: 'technical', token: 'tok', request, putIcloudObject: async () => { throw new Error('no debe llamarse'); } }),
      /no es un respaldo de borrado valido/
    );
  });

  await test('aborta si los fragmentos no descomprimen (dato corrupto)', async () => {
    const event = packBackupEvent({ id: 'de1corrupt' });
    event.extendedProperties.private.data0 = 'AAAA' + event.extendedProperties.private.data0.slice(4);
    const request = async () => event;
    let called = false;
    await assert.rejects(
      () => restoreFromDeletionBackup({
        backupId: 'de1corrupt', calendarId: 'technical', token: 'tok', request,
        putIcloudObject: async () => { called = true; },
      }),
      /Respaldo corrupto: no se pudo descomprimir/
    );
    assert.equal(called, false);
  });

  await test('aborta si el checksum guardado no coincide tras descomprimir bien', async () => {
    const event = packBackupEvent({ id: 'de1mismatch' });
    event.extendedProperties.private.checksum = 'checksum-que-no-coincide';
    const request = async () => event;
    let called = false;
    await assert.rejects(
      () => restoreFromDeletionBackup({
        backupId: 'de1mismatch', calendarId: 'technical', token: 'tok', request,
        putIcloudObject: async () => { called = true; },
      }),
      /Checksum del respaldo no coincide/
    );
    assert.equal(called, false);
  });

  await test('propaga el error de iCloud si ya existe un evento en ese href (nunca sobreescribe)', async () => {
    const event = packBackupEvent({ id: 'de1exists' });
    const request = async () => event;
    const putIcloudObject = async () => {
      const error = new Error('iCloud CalDAV PUT failed (412)');
      error.status = 412;
      throw error;
    };
    await assert.rejects(
      () => restoreFromDeletionBackup({ backupId: 'de1exists', calendarId: 'technical', token: 'tok', request, putIcloudObject }),
      /412/
    );
  });

  await test('lista los respaldos disponibles con sus metadatos legibles, con paginacion', async () => {
    const first = packBackupEvent({ id: 'de1first', summary: 'santiago ruiz - 150€', start: { dateTime: '2026-09-20T15:00:00+02:00' } });
    const second = packBackupEvent({ id: 'de1second', summary: 'carla - 30', start: { dateTime: '2026-09-21T20:00:00+02:00' } });
    const calls = [];
    const request = async (method, path) => {
      calls.push(path);
      assert.match(path, /privateExtendedProperty=deletionBackup%3Dv1/);
      if (!path.includes('pageToken')) return { items: [first], nextPageToken: 'p2' };
      return { items: [second] };
    };
    const backups = await listDeletionBackups({ calendarId: 'technical', token: 'tok', request });
    assert.equal(calls.length, 2);
    assert.deepEqual(backups.map(b => b.id), ['de1first', 'de1second']);
    assert.equal(backups[0].summary, 'santiago ruiz - 150€');
    assert.equal(backups[0].deletedAt, '2026-09-18T10:00:00.000Z');
  });

  await test('lista vacia cuando no hay respaldos', async () => {
    const backups = await listDeletionBackups({ calendarId: 'technical', token: 'tok', request: async () => ({ items: [] }) });
    assert.deepEqual(backups, []);
  });

  console.log(`\nTotal: ${passed + failed} | OK: ${passed} | FAIL: ${failed}`);
  if (failed) process.exitCode = 1;
}

run();
