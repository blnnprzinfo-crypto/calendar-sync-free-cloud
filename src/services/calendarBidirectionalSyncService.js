'use strict';

const { createHash, randomUUID } = require('node:crypto');
const icloud = require('./icloudCalDavService');
const googleAuth = require('./googleCalendarAuthService');

const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3';

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function normalizeName(value) {
  return String(value || '').trim().normalize('NFC').toLocaleLowerCase('es');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getConflictPolicy() {
  const policy = String(process.env.CALENDAR_SYNC_CONFLICT_POLICY || 'newest_wins').trim().toLowerCase();
  if (!['newest_wins', 'icloud_wins'].includes(policy)) {
    throw new Error('CALENDAR_SYNC_CONFLICT_POLICY debe ser newest_wins o icloud_wins.');
  }
  return policy;
}

function getWindow(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - parseNonNegativeInt(process.env.ICLOUD_SYNC_PAST_DAYS, 7));
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + parsePositiveInt(process.env.ICLOUD_SYNC_FUTURE_DAYS, 180));
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function parseJsonAllowlist(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`${name} no es JSON valido: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} debe ser un array JSON de textos no vacios.`);
  }
  return parsed.map(value => value.trim());
}

function enforceCalendarAllowlist(mappings) {
  if (process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST !== 'true') return;
  const icloudNames = parseJsonAllowlist('CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON');
  const googleIds = parseJsonAllowlist('CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON');
  if (icloudNames.length === 0 || googleIds.length === 0) {
    throw new Error('La allowlist estricta exige nombres iCloud e IDs Google explicitos.');
  }
  const allowedIcloud = new Set(icloudNames.map(normalizeName));
  const allowedGoogle = new Set(googleIds);
  for (const mapping of mappings) {
    if (!allowedIcloud.has(normalizeName(mapping.icloudName))) {
      throw new Error(`Calendario iCloud fuera de la allowlist: ${mapping.icloudName}`);
    }
    if (!allowedGoogle.has(mapping.googleCalendarId)) {
      throw new Error(`Calendario Google fuera de la allowlist: ${mapping.googleCalendarId}`);
    }
  }
}

function getCalendarMap() {
  const raw = String(process.env.CALENDAR_SYNC_MAP_JSON || '').trim();
  if (!raw) throw new Error('Falta CALENDAR_SYNC_MAP_JSON.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`CALENDAR_SYNC_MAP_JSON no es JSON valido: ${err.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('CALENDAR_SYNC_MAP_JSON debe ser un objeto nombre_iCloud -> id_Google.');
  }
  const mappings = Object.entries(parsed).map(([icloudName, googleCalendarId]) => ({
    icloudName: String(icloudName).trim(),
    googleCalendarId: String(googleCalendarId).trim(),
  })).filter(item => item.icloudName && item.googleCalendarId);
  if (mappings.length === 0) throw new Error('CALENDAR_SYNC_MAP_JSON no contiene calendarios.');
  const expectedCount = Number.parseInt(process.env.CALENDAR_SYNC_EXPECTED_MAPPING_COUNT || '', 10);
  if (Number.isFinite(expectedCount) && expectedCount > 0 && mappings.length !== expectedCount) {
    throw new Error(`El mapa contiene ${mappings.length} calendarios; se esperaban ${expectedCount}.`);
  }
  enforceCalendarAllowlist(mappings);
  return mappings;
}

async function googleRequest(method, path, token, body = null) {
  const response = await fetch(`${GOOGLE_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(`Google Calendar ${method} fallo (${response.status}): ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function privateProps(event) {
  return event?.extendedProperties?.private || {};
}

// Google devuelve las horas con desfase local ("2026-08-14T16:00:00+02:00") y
// iCloud las devuelve en UTC ("2026-08-14T14:00:00.000Z"). Es el mismo instante,
// asi que hay que compararlas normalizadas: si no, cada pasada cree que el otro
// lado cambio y los dos calendarios se reescriben en bucle.
function canonicalTime(value) {
  if (value?.date) return `date:${value.date}`;
  if (!value?.dateTime) return '';
  const parsed = new Date(value.dateTime);
  return Number.isNaN(parsed.getTime()) ? String(value.dateTime) : parsed.toISOString();
}

function comparableEvent(event) {
  return {
    summary: String(event?.summary || 'ocupado'),
    description: String(event?.description || '').replace(/\n\nSincronizado (?:desde Apple|hacia Apple) Calendar para Belenciaga\.$/, ''),
    location: String(event?.location || ''),
    start: event?.start || null,
    end: event?.end || null,
    recurrence: Array.isArray(event?.recurrence) ? event.recurrence : [],
    status: event?.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}

function contentFingerprint(event) {
  const comparable = comparableEvent(event);
  return sha1(JSON.stringify({
    ...comparable,
    start: canonicalTime(comparable.start),
    end: canonicalTime(comparable.end),
  }));
}

// Huella anterior al arreglo de zonas horarias. Solo se usa para reconocer los
// eventos ya sincronizados con el formato viejo y no reescribirlos sin motivo.
function legacyContentFingerprint(event) {
  return sha1(JSON.stringify(comparableEvent(event)));
}

function looseFingerprint(event) {
  const comparable = comparableEvent(event);
  return sha1(JSON.stringify({
    summary: comparable.summary.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es'),
    start: canonicalTime(comparable.start),
    end: canonicalTime(comparable.end),
    recurrence: comparable.recurrence,
  }));
}

function summaryDateKey(event) {
  const comparable = comparableEvent(event);
  const summary = comparable.summary.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
  const startDate = comparable.start?.date || String(comparable.start?.dateTime || '').slice(0, 10);
  return `${summary}|${startDate}`;
}

function escapeIcs(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function toIcsDateValue(value, fallbackTimezone = 'Europe/Madrid') {
  if (value?.date) return { line: `;VALUE=DATE:${value.date.replace(/-/g, '')}`, allDay: true };
  if (!value?.dateTime) return null;
  const parsed = new Date(value.dateTime);
  if (!Number.isNaN(parsed.getTime())) {
    return { line: `:${parsed.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`, allDay: false };
  }
  const raw = String(value.dateTime).replace(/[-:]/g, '').replace(/\.\d+$/, '');
  return { line: `;TZID=${value.timeZone || fallbackTimezone}:${raw}`, allDay: false };
}

function googleEventToIcs(event, uid) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const start = toIcsDateValue(event.start);
  const end = toIcsDateValue(event.end);
  if (!start || !end) throw new Error(`Evento Google sin fechas validas: ${event.id || event.summary}`);
  const recurrence = (event.recurrence || []).filter(line => /^(RRULE|EXDATE):/i.test(line));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Belenciaga//Calendar Bridge//ES',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${now}`,
    `LAST-MODIFIED:${now}`,
    `DTSTART${start.line}`,
    `DTEND${end.line}`,
    `SUMMARY:${escapeIcs(event.summary || 'ocupado')}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  lines.push(...recurrence, 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function sourceKey(calendarUrl, uid) {
  return sha1(`${calendarUrl}|${uid}`);
}

function buildGoogleFromIcloud(event, googleFingerprint = '') {
  const recurring = Boolean(event.recurrence?.length);
  const start = recurring && event.start?.dateTime && !event.start.timeZone
    ? { ...event.start, timeZone: process.env.TZ || 'Europe/Madrid' }
    : event.start;
  const end = recurring && event.end?.dateTime && !event.end.timeZone
    ? { ...event.end, timeZone: process.env.TZ || 'Europe/Madrid' }
    : event.end;
  const body = {
    summary: event.summary || 'ocupado',
    description: event.description || undefined,
    location: event.location || undefined,
    start,
    end,
    recurrence: event.recurrence?.length ? event.recurrence : undefined,
    status: 'confirmed',
    transparency: 'opaque',
    extendedProperties: { private: {
      belenciagaSource: 'icloud-caldav-bidirectional',
      belenciagaSourceKey: event.sourceKey,
      belenciagaIcloudUid: event.uid,
      belenciagaIcloudCalendar: event.calendarName || '',
      belenciagaIcloudFingerprint: event.fingerprint,
      belenciagaGoogleFingerprint: googleFingerprint || contentFingerprint(event),
    } },
  };
  return body;
}

async function listGoogleEvents({ token, calendarId, start, end, request = googleRequest }) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      maxResults: '2500', showDeleted: 'true', singleEvents: 'false',
      timeMin: start.toISOString(), timeMax: end.toISOString(),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await request('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${params}`, token);
    items.push(...(data?.items || []));
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return items;
}

function parseIcloudTimestamp(raw) {
  const value = String(raw || '');
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

function selectConflictWinner(icloudEvent, googleEvent, policy = getConflictPolicy()) {
  if (policy === 'icloud_wins') return 'icloud';
  const appleTime = parseIcloudTimestamp(icloudEvent.lastModified);
  const googleTime = Date.parse(googleEvent.updated || '') || 0;
  return googleTime > appleTime ? 'google' : 'icloud';
}

function eventHref(calendar, uid) {
  return new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href;
}

async function syncCalendarPair({ mapping, calendar, icloudEvents, token, start, end, dryRun, request }) {
  const googleEvents = await listGoogleEvents({ token, calendarId: mapping.googleCalendarId, start, end, request });
  const icloudByKey = new Map(icloudEvents.map(event => [event.sourceKey, event]));
  const googleByKey = new Map();
  const unlinkedByLooseFingerprint = new Map();
  const unlinkedBySummaryDate = new Map();
  for (const event of googleEvents) {
    const key = privateProps(event).belenciagaSourceKey;
    if (key && !googleByKey.has(key)) googleByKey.set(key, event);
    if (!key && event.status !== 'cancelled') {
      const loose = looseFingerprint(event);
      if (!unlinkedByLooseFingerprint.has(loose)) unlinkedByLooseFingerprint.set(loose, []);
      unlinkedByLooseFingerprint.get(loose).push(event);
      const summaryDate = summaryDateKey(event);
      if (!unlinkedBySummaryDate.has(summaryDate)) unlinkedBySummaryDate.set(summaryDate, []);
      unlinkedBySummaryDate.get(summaryDate).push(event);
    }
  }
  const operations = [];
  const consumedGoogleIds = new Set();

  for (const appleEvent of icloudEvents) {
    const googleEvent = googleByKey.get(appleEvent.sourceKey);
    if (!googleEvent) {
      let candidates = (unlinkedByLooseFingerprint.get(looseFingerprint(appleEvent)) || [])
        .filter(candidate => !consumedGoogleIds.has(candidate.id));
      if (candidates.length === 0) {
        candidates = (unlinkedBySummaryDate.get(summaryDateKey(appleEvent)) || [])
          .filter(candidate => !consumedGoogleIds.has(candidate.id));
      }
      if (candidates.length === 1) {
        const candidate = candidates[0];
        consumedGoogleIds.add(candidate.id);
        operations.push({ type: 'link_existing', calendar: mapping.icloudName, summary: appleEvent.summary, sourceKey: appleEvent.sourceKey, googleUpdated: candidate.updated || '' });
        if (!dryRun) {
          await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(candidate.id)}?sendUpdates=none`, token, {
            extendedProperties: { private: {
              ...privateProps(candidate),
              belenciagaSource: 'icloud-caldav-bidirectional',
              belenciagaSourceKey: appleEvent.sourceKey,
              belenciagaIcloudUid: appleEvent.uid,
              belenciagaIcloudCalendar: appleEvent.calendarName || mapping.icloudName,
              belenciagaIcloudFingerprint: appleEvent.fingerprint,
              belenciagaGoogleFingerprint: contentFingerprint(candidate),
            } },
          });
        }
        continue;
      }
      operations.push({ type: 'create_google', calendar: mapping.icloudName, summary: appleEvent.summary, sourceKey: appleEvent.sourceKey, googleUpdated: '' });
      if (!dryRun) {
        const created = await request('POST', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events?sendUpdates=none`, token, buildGoogleFromIcloud(appleEvent));
        if (created?.id) {
          await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(created.id)}?sendUpdates=none`, token, {
            extendedProperties: { private: {
              ...privateProps(created),
              belenciagaGoogleFingerprint: contentFingerprint(created),
            } },
          });
        }
      }
      continue;
    }
    googleByKey.delete(appleEvent.sourceKey);
    const props = privateProps(googleEvent);
    const appleChanged = props.belenciagaIcloudFingerprint !== appleEvent.fingerprint;
    const currentGoogleFingerprint = contentFingerprint(googleEvent);
    const googleChanged = Boolean(props.belenciagaGoogleFingerprint)
      && props.belenciagaGoogleFingerprint !== currentGoogleFingerprint
      && props.belenciagaGoogleFingerprint !== legacyContentFingerprint(googleEvent);
    if (!appleChanged && !googleChanged) {
      operations.push({ type: 'skip_unchanged', calendar: mapping.icloudName, summary: appleEvent.summary, sourceKey: appleEvent.sourceKey, googleUpdated: googleEvent.updated || '' });
      continue;
    }
    const winner = appleChanged && googleChanged ? selectConflictWinner(appleEvent, googleEvent) : (googleChanged ? 'google' : 'icloud');
    if (winner === 'google') {
      operations.push({ type: 'update_icloud', calendar: mapping.icloudName, summary: googleEvent.summary, sourceKey: appleEvent.sourceKey, googleUpdated: googleEvent.updated || '' });
      if (!dryRun) {
        await icloud.putCalendarObject({
          url: appleEvent.href,
          etag: appleEvent.etag,
          ics: googleEventToIcs(googleEvent, appleEvent.uid),
        });
        await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(googleEvent.id)}?sendUpdates=none`, token, {
          extendedProperties: { private: { ...props, belenciagaGoogleFingerprint: currentGoogleFingerprint } },
        });
      }
    } else {
      operations.push({ type: 'update_google', calendar: mapping.icloudName, summary: appleEvent.summary, sourceKey: appleEvent.sourceKey, googleUpdated: googleEvent.updated || '' });
      if (!dryRun) {
        const updated = await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(googleEvent.id)}?sendUpdates=none`, token, buildGoogleFromIcloud(appleEvent));
        // Google normaliza el evento al guardarlo, asi que la huella se toma de
        // lo que Google devuelve, no de lo que le enviamos.
        if (updated?.id) {
          await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(updated.id)}?sendUpdates=none`, token, {
            extendedProperties: { private: {
              ...privateProps(updated),
              belenciagaGoogleFingerprint: contentFingerprint(updated),
            } },
          });
        }
      }
    }
  }

  for (const googleEvent of googleEvents) {
    if (consumedGoogleIds.has(googleEvent.id)) continue;
    if (googleEvent.status === 'cancelled') {
      // Politica permanente de este puente: un borrado nunca se replica.
      continue;
    }
    const props = privateProps(googleEvent);
    const linkedKey = props.belenciagaSourceKey;
    if (linkedKey) {
      // Si falta el original de iCloud, conservamos la copia de Google.
      continue;
    }
    const uid = `belenciaga-google-${randomUUID()}@calendar-sync`;
    const key = sourceKey(calendar.url, uid);
    operations.push({ type: 'create_icloud', calendar: mapping.icloudName, summary: googleEvent.summary, sourceKey: key, googleUpdated: googleEvent.updated || '' });
    if (!dryRun) {
      await icloud.putCalendarObject({
        url: eventHref(calendar, uid),
        ics: googleEventToIcs(googleEvent, uid),
        createOnly: true,
      });
      await request('PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(googleEvent.id)}?sendUpdates=none`, token, {
        extendedProperties: { private: {
          ...props,
          belenciagaSource: 'google-calendar-bidirectional',
          belenciagaSourceKey: key,
          belenciagaIcloudUid: uid,
          belenciagaIcloudCalendar: mapping.icloudName,
          belenciagaIcloudFingerprint: '',
          belenciagaGoogleFingerprint: contentFingerprint(googleEvent),
        } },
      });
    }
  }
  return operations;
}

async function syncBidirectional(options = {}) {
  const dryRun = options.dryRun ?? process.env.CALENDAR_BIDIRECTIONAL_DRY_RUN !== 'false';
  if (process.env.CALENDAR_SYNC_PROPAGATE_DELETES === 'true') {
    throw new Error('CALENDAR_SYNC_PROPAGATE_DELETES=true esta prohibido: este sincronizador nunca propaga borrados.');
  }
  const propagateDeletes = false;
  const conflictPolicy = getConflictPolicy();
  const mappings = getCalendarMap();
  const { start, end } = getWindow(options.now || new Date());
  const discovered = await icloud.discoverCalendars();
  const calendarByName = new Map(discovered.map(calendar => [normalizeName(calendar.name), calendar]));
  const token = options.tokenOverride || await googleAuth.getAccessToken();
  const request = options.googleRequestOverride || googleRequest;
  const allOperations = [];

  for (const mapping of mappings) {
    const calendar = calendarByName.get(normalizeName(mapping.icloudName));
    if (!calendar) throw new Error(`No existe el calendario iCloud: ${mapping.icloudName}`);
    try {
      const events = await icloud.fetchEventsFromCalendar(calendar, start, end);
      const operations = await syncCalendarPair({ mapping, calendar, icloudEvents: events, token, start, end, dryRun, request });
      allOperations.push(...operations);
    } catch (error) {
      throw new Error(`${mapping.icloudName}: ${error.message}`);
    }
  }

  const counts = {};
  for (const operation of allOperations) counts[operation.type] = (counts[operation.type] || 0) + 1;
  return {
    dryRun,
    propagateDeletes,
    conflictPolicy,
    window: { start: start.toISOString(), end: end.toISOString() },
    calendars: mappings.map(item => item.icloudName),
    counts,
    operations: allOperations,
  };
}

module.exports = {
  syncBidirectional,
  getCalendarMap,
  getConflictPolicy,
  contentFingerprint,
  looseFingerprint,
  summaryDateKey,
  googleEventToIcs,
  selectConflictWinner,
  _private: { buildGoogleFromIcloud, sourceKey, syncCalendarPair, normalizeName, legacyContentFingerprint, canonicalTime },
};
