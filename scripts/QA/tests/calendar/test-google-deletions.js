'use strict';
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const service = require('../../../../src/services/calendarBidirectionalSyncService');
const apple = require('../../../../src/services/icloudCalDavService');
const { backupBeforeDeletion } = require('../../../../src/services/calendarDeletionBackup');

async function scenario(mode) {
  const calendar = { name: 'test', url: 'https://icloud.test/cal/' };
  const mapping = { icloudName: 'test', googleCalendarId: 'google-test' };
  const event = { uid: 'uid', href: calendar.url + 'uid.ics', etag: 'apple-etag',
    sourceKey: service._private.sourceKey(calendar.url, 'uid'), fingerprint: 'fp',
    summary: 'Test', start: { date: '2026-09-16' }, end: { date: '2026-09-17' } };
  const cancelled = { id: 'google-event', etag: 'google-etag', status: 'cancelled',
    extendedProperties: { private: { belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaIcloudUid: event.uid, belenciagaSourceKey: event.sourceKey,
      belenciagaIcloudCalendar: 'test', belenciagaIcloudFingerprint: 'fp',
      belenciagaGoogleFingerprint: service.contentFingerprint(event) } } };
  if (mode === 'untrusted') cancelled.extendedProperties.private.belenciagaIcloudCalendar = 'other';
  if (mode === 'instance') cancelled.recurringEventId = 'series';
  if (mode === 'missing-etag') event.etag = '';
  let backup = null, reads = 0, deletes = 0, posts = 0;
  const originalGet = apple._private.caldavRequest, originalDelete = apple.deleteCalendarObject;
  const oldCalendar = process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID = 'technical';
  const originalIcs = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  apple._private.caldavRequest = async method => { assert.equal(method, 'GET'); return { text: originalIcs, etag: 'apple-raw-etag' }; };
  apple.deleteCalendarObject = async args => {
    assert.ok(backup, 'Durable backup must precede deletion');
    assert.deepEqual(args, { url: event.href, etag: event.etag });
    if (mode === 'apple-changed') { const e = new Error('precondition'); e.status = 412; throw e; }
    deletes++;
  };
  const request = async (method, url, token, body) => {
    if (url.includes('/calendars/technical/events')) {
      if (method === 'POST') {
        posts++;
        if (mode === 'backup-fails') throw new Error('backup unavailable');
        backup = structuredClone(body); return backup;
      }
      if (mode === 'backup-corrupt') backup.extendedProperties.private.data0 = 'truncated';
      return backup;
    }
    assert.equal(method, 'GET', 'Original Google event must not be modified');
    if (url.includes('maxResults')) return { items: mode === 'active-copy'
      ? [cancelled, { ...event, id: 'active-copy', status: 'confirmed', extendedProperties: cancelled.extendedProperties }]
      : [cancelled] };
    reads++;
    if (mode === 'restored' || (mode === 'restored-after-backup' && reads === 2)) return { ...cancelled, status: 'confirmed' };
    return cancelled;
  };
  try {
    const invoke = () => service._private.syncCalendarPair({ mapping, calendar, icloudEvents: [event],
      token: 'fake', start: new Date('2026-09-01Z'), end: new Date('2026-10-01Z'),
      dryRun: mode === 'dry', googleDeletesToIcloud: true, request });
    if (['backup-fails', 'backup-corrupt', 'apple-changed'].includes(mode)) {
      await assert.rejects(invoke); assert.equal(deletes, 0);
    } else {
      const ops = await invoke();
      assert.equal(deletes, mode === 'apply' ? 1 : 0);
      if (['apply', 'dry'].includes(mode)) assert.equal(ops[0].type, 'delete_icloud');
      else assert.ok(!ops.some(op => op.type === 'delete_icloud'));
      if (mode === 'dry') assert.equal(posts, 0);
      if (mode === 'apply') {
        const props = backup.extendedProperties.private;
        const packed = Array.from({ length: Number(props.chunks) }, (_, i) => props[`data${i}`]).join('');
        const recovered = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')));
        assert.equal(recovered.ics, originalIcs);
        assert.equal(recovered.href, event.href);
        // A second pass with the Apple event absent must not recreate either side.
        const repeated = await service._private.syncCalendarPair({ mapping, calendar, icloudEvents: [],
          token: 'fake', start: new Date('2026-09-01Z'), end: new Date('2026-10-01Z'),
          dryRun: false, googleDeletesToIcloud: true, request });
        assert.deepEqual(repeated, []);
        assert.equal(deletes, 1);
      }
    }
    console.log(`OK Google deletion: ${mode}`);
  } finally {
    apple._private.caldavRequest = originalGet; apple.deleteCalendarObject = originalDelete;
    if (oldCalendar === undefined) delete process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
    else process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID = oldCalendar;
  }
}

(async () => {
  for (const mode of ['dry', 'apply', 'untrusted', 'instance', 'missing-etag', 'active-copy',
    'backup-fails', 'backup-corrupt', 'restored', 'restored-after-backup', 'apple-changed']) await scenario(mode);
  const old = process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  delete process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  try { await assert.rejects(() => backupBeforeDeletion({}), /calendario tecnico/); }
  finally { if (old !== undefined) process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID = old; }
  console.log('OK Google deletion: missing backup calendar fails closed');
})().catch(error => { console.error(error); process.exitCode = 1; });
