'use strict';

// One-time, fail-closed cleanup requested by the calendar owner.
// Scope: the Friday 2026-10-16 itinerary in the mapped "planes" calendar only.
// Calendar appointments are removed; external bookings are not touched.
require('dotenv').config();
const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const icloud = require('../../../src/services/icloudCalDavService');
const googleAuth = require('../../../src/services/googleCalendarAuthService');
const { getCalendarMap, _private: { normalizeName } } = require('../../../src/services/calendarBidirectionalSyncService');
const { createRemoteLease } = require('../../../src/services/calendarSyncRemoteLease');

const DATE = '2026-10-16';
const FROM = new Date('2026-10-15T22:00:00Z');
const TO = new Date('2026-10-16T22:00:00Z');
const TIME_ZONE = 'Europe/Madrid';
const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3';
const TITLES = new Set([
  '✅ CONFIRMADO · Tren Orihuela → Cuenca Fernando Zóbel',
  'BILLETE COMPRADO · Tren Orihuela → Cuenca',
  '🚕 Traslado en taxi y consultar depósito de maletas',
  '🚶 Del apartamento a Vibra Burger',
  '🍔 ELEGIDO · Comer en Vibra Burger',
  'CONFIRMADO · Apartamento Blanca, Alfonso VIII 20',
  '🚶 Vibra Burger → Catedral (subida)',
  '⛪ ELEGIDO · Catedral de Cuenca',
  '🚶 Catedral → encuentro del free tour',
  'CONFIRMADO · Free tour por Cuenca (2)',
  '✅ CONFIRMADO · Free tour histórico por Cuenca',
  '🌇 OPCIONAL · Mirador al atardecer si queda cerca',
  '🕯️ ELEGIDO · Cena en Posada de San José',
  '🚶 Posada de San José → apartamento',
]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const log = (name, extra = {}) => console.log(JSON.stringify({ phase: name, ...extra }));

function civilDate(event) {
  if (event?.start?.date) return String(event.start.date);
  const dateTime = String(event?.start?.dateTime || '');
  if (!dateTime) return '';
  const time = new Date(dateTime);
  if (Number.isNaN(time.getTime())) return '';
  const components = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(time);
  const component = k => components.find(x => x.type === k)?.value;
  return [component('year'), component('month'), component('day')].join('-');
}
function matches(event) {
  return event && TITLES.has(event.summary) && civilDate(event) === DATE;
}
function assertSingleInstance(event) {
  if (event.recurringEventId || event.originalStartTime
      || (event.recurrence && event.recurrence.length)
      || event.recurrenceId) {
    throw new Error('ABORT: repeating/instance event in cleanup scope');
  }
}

async function googleRequest(method, path, token, body, headers = {}) {
  const response = await fetch(GOOGLE_BASE + path, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) {} }
  if (!response.ok) {
    const error = new Error('Google ' + method + ' failed HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function listGoogle(calendarId, token) {
  const events = [];
  let page = '';
  do {
    const q = new URLSearchParams({
      timeMin: FROM.toISOString(), timeMax: TO.toISOString(),
      maxResults: '2500', showDeleted: 'false', singleEvents: 'false',
    });
    if (page) q.set('pageToken', page);
    const result = await googleRequest('GET', '/calendars/' + encodeURIComponent(calendarId) + '/events?' + q, token);
    events.push(...(result?.items || []));
    page = result?.nextPageToken || '';
  } while (page);
  return events;
}

function backupPayloadSize(payload) {
  const bytes = gzipSync(JSON.stringify(payload)).toString('base64');
  if (bytes.length > 21000) throw new Error('ABORT: backup too large');
  return bytes;
}
async function persistBackup(token, payload) {
  const text = JSON.stringify(payload);
  const packed = backupPayloadSize(payload);
  const chunks = packed.match(/.{1,900}/g) || [];
  const checksum = sha256(text);
  const id = 'cu' + sha256('cuenca-20261016|' + payload.kind + '|' + payload.key + '|' + checksum).slice(0, 48);
  const calendarId = process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  if (!calendarId) throw new Error('ABORT: missing backup calendar');
  const base = '/calendars/' + encodeURIComponent(calendarId) + '/events';
  const properties = { cuencaCleanupBackup: 'v1', checksum, chunks: String(chunks.length) };
  chunks.forEach((value, i) => { properties['data' + i] = value; });
  try {
    await googleRequest('POST', base + '?sendUpdates=none', token, {
      id, summary: '[tecnico] Respaldo limpieza Cuenca 2026-10-16',
      start: { date: '2000-01-01' }, end: { date: '2000-01-02' },
      transparency: 'transparent', visibility: 'private',
      extendedProperties: { private: properties },
    });
  } catch (error) { if (error.status !== 409) throw error; }
  const saved = await googleRequest('GET', base + '/' + id, token);
  const props = saved?.extendedProperties?.private || {};
  if (saved.status === 'cancelled' || props.cuencaCleanupBackup !== 'v1'
      || props.checksum !== checksum || props.chunks !== String(chunks.length)) {
    throw new Error('ABORT: backup verification failed');
  }
  const restored = gunzipSync(Buffer.from(chunks.map((_,i) => props['data' + i] || '').join(''), 'base64')).toString();
  if (restored !== text || sha256(restored) !== checksum) throw new Error('ABORT: corrupt backup');
}

async function prepare() {
  if (process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST !== 'true') throw new Error('ABORT: strict allowlist must be on');
  const matchesMap = getCalendarMap().filter(x => normalizeName(x.icloudName).startsWith('planes'));
  if (matchesMap.length !== 1) throw new Error('ABORT: expected exactly one mapped planes calendar');
  const mapping = matchesMap[0];
  if (mapping.googleCalendarId !== 'adb50694b3065cfe8bea3d5139a081f827be2c0c5e6060d14399fd7d6f33ab6b@group.calendar.google.com') {
    throw new Error('ABORT: unexpected destination Google calendar');
  }
  if (!process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID || process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID === mapping.googleCalendarId) {
    throw new Error('ABORT: technical backup calendar must be separate');
  }
  const calendars = (await icloud.discoverCalendars()).filter(x => normalizeName(x.name) === normalizeName(mapping.icloudName));
  if (calendars.length !== 1) throw new Error('ABORT: mapped iCloud calendar not unique');
  const calendar = calendars[0];
  const token = await googleAuth.getAccessToken();
  const [appleAll, googleAll] = await Promise.all([
    icloud.fetchEventsFromCalendar(calendar, FROM, TO),
    listGoogle(mapping.googleCalendarId, token),
  ]);
  const apple = appleAll.filter(matches);
  const google = googleAll.filter(matches);
  if (apple.length > 25 || google.length > 25) throw new Error('ABORT: too many target events');
  for (const event of [...apple, ...google]) assertSingleInstance(event);
  if (new Set(apple.map(x => x.href)).size !== apple.length) throw new Error('ABORT: multiple events in one iCloud object');
  // Explicitly refuse to delete an iCloud calendar resource with other instances.
  const appleObjects = [];
  for (const item of apple) {
    const ics = await icloud._private.caldavRequest('GET', item.href, null, { 'Content-Type': 'text/calendar; charset=utf-8' });
    const eventBlocks = ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
    // VTIMEZONE can legitimately contain RRULE/RDATE for daylight-saving
    // transitions; only recurrence inside VEVENT would make deletion unsafe.
    if (eventBlocks.length !== 1
      || /(?:^|\r?\n)(?:RRULE|RDATE|RECURRENCE-ID)[;:]/im.test(eventBlocks[0])) {
      throw new Error('ABORT: iCloud VEVENT includes recurrence or multi-event resource');
    }
    appleObjects.push({ ...item, ics });
    backupPayloadSize({ kind: 'icloud', key: item.href, ics, etag: item.etag });
  }
  for (const event of google) {
    backupPayloadSize({ kind: 'google', key: event.id, calendarId: mapping.googleCalendarId, event });
  }
  return { mapping, calendar, token, apple: appleObjects, google, allApple: appleAll.length, allGoogle: googleAll.length };
}

async function run({ apply }) {
  let lease = null;
  try {
    if (apply) {
      if (process.env.CUENCA_CLEANUP_APPLY !== 'true') throw new Error('ABORT: apply not explicitly enabled');
      lease = createRemoteLease({ writerId: 'cuenca-friday-cleanup' });
      await lease.acquire();
    }
    const plan = await prepare();
    log('preflight', { date: DATE, apple: plan.apple.length, google: plan.google.length,
      otherAppleIgnored: plan.allApple - plan.apple.length,
      otherGoogleIgnored: plan.allGoogle - plan.google.length, mode: apply ? 'apply' : 'dry-run' });
    if (!apply) return;
    // Persist and verify EVERY backup before starting ANY destructive operation.
    for (const item of plan.apple) {
      await persistBackup(plan.token, { kind: 'icloud', key: item.href,
        ics: item.ics, etag: item.etag, calendar: plan.mapping.icloudName });
    }
    for (const event of plan.google) {
      await persistBackup(plan.token, { kind: 'google', key: event.id,
        calendarId: plan.mapping.googleCalendarId, event });
    }
    log('backups-verified', { apple: plan.apple.length, google: plan.google.length });
    let appleDeleted = 0, googleDeleted = 0;
    for (const item of plan.apple) {
      try {
        await icloud.deleteCalendarObject({ url: item.href, etag: item.etag });
        appleDeleted++;
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error;
      }
    }
    for (const event of plan.google) {
      const path = '/calendars/' + encodeURIComponent(plan.mapping.googleCalendarId)
        + '/events/' + encodeURIComponent(event.id);
      let current = null;
      try { current = await googleRequest('GET', path, plan.token); }
      catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
      if (!current || current.status === 'cancelled') continue;
      if (!matches(current)) throw new Error('ABORT: Google event changed during cleanup');
      assertSingleInstance(current);
      try {
        await googleRequest('DELETE', path + '?sendUpdates=none', plan.token, undefined,
          current.etag ? { 'If-Match': current.etag } : {});
        googleDeleted++;
      } catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
    }
    log('deleted', { apple: appleDeleted, google: googleDeleted });
    const check = await prepare();
    log('verified', { remainingApple: check.apple.length, remainingGoogle: check.google.length });
    if (check.apple.length || check.google.length) throw new Error('FAIL: matching events remain after cleanup');
  } finally {
    if (lease) await lease.release();
  }
}
if (require.main === module) {
  run({ apply: process.argv.includes('--apply') }).catch(error => {
    console.error('[cuenca-cleanup] ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = { civilDate, matches, assertSingleInstance, run };
