'use strict';

const { createHash } = require('node:crypto');
const { parseIcsEvents } = require('./calendarIcsEventParser');
const googleAuth = require('./googleCalendarAuthService');

const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3';

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function normalizedCalendarName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, '');
}

function getTargetMapping() {
  const raw = String(process.env.CALENDAR_SYNC_MAP_JSON || '').trim();
  if (!raw) throw new Error('Falta CALENDAR_SYNC_MAP_JSON para localizar el calendario de Aules.');
  let map;
  try { map = JSON.parse(raw); } catch (error) {
    throw new Error(`CALENDAR_SYNC_MAP_JSON no es JSON valido: ${error.message}`);
  }
  if (!map || Array.isArray(map) || typeof map !== 'object') {
    throw new Error('CALENDAR_SYNC_MAP_JSON debe ser un objeto nombre_iCloud -> id_Google.');
  }
  const requested = String(process.env.AULES_TARGET_ICLOUD_NAME || 'Uni').trim();
  const target = normalizedCalendarName(requested);
  const matches = Object.entries(map).filter(([name, googleCalendarId]) => (
    normalizedCalendarName(name) === target && String(googleCalendarId || '').trim()
  ));
  if (matches.length !== 1) {
    throw new Error(`El calendario destino de Aules debe tener exactamente una coincidencia; encontradas: ${matches.length}.`);
  }
  return { icloudName: matches[0][0], googleCalendarId: String(matches[0][1]).trim() };
}

async function googleRequest(method, path, token, body = null) {
  const response = await fetch(`${GOOGLE_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  }
  if (!response.ok) throw new Error(`Google Calendar ${method} fallo (${response.status}).`);
  return data;
}

async function fetchFeed(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'text/calendar' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (_) {
    throw new Error('No se pudo descargar el feed de Aules.');
  }
  if (!response.ok) throw new Error(`Aules devolvio HTTP ${response.status}.`);
  const text = await response.text();
  const trimmed = text.trim();
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!trimmed) throw new Error('Aules devolvio contenido vacio.');
  if (/text\/html|application\/xhtml/.test(contentType) || /^\s*<!doctype\s+html|^\s*<html/i.test(trimmed)) {
    throw new Error('Aules devolvio HTML en vez de ICS.');
  }
  if (!/^BEGIN:VCALENDAR(?:\r?\n|$)/m.test(trimmed) || !/(?:^|\r?\n)END:VCALENDAR(?:\r?\n|$)/m.test(trimmed)) {
    throw new Error('Aules devolvio contenido ICS no valido.');
  }
  return text;
}

function addDay(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error('Una entrega de Aules contiene una fecha no valida.');
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function originalDeadline(event) {
  const raw = String(event.originalStart || '').trim();
  if (/^\d{8}T\d{4}(?:\d{2})?Z?$/.test(raw)) {
    const seconds = raw.slice(13, 15) || '00';
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(9, 11)}:${raw.slice(11, 13)}:${seconds}${raw.endsWith('Z') ? ' UTC' : ''}`;
  }
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

function deadlineDate(event, timeZone = process.env.TZ || 'Europe/Madrid') {
  if (event.start?.date) return event.start.date;
  const dateTime = String(event.start?.dateTime || '');
  if (!dateTime) return '';

  // Moodle commonly exports deadlines in UTC. Convert instants to the target
  // calendar's civil date so a 23:59 deadline does not land one day early.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(dateTime)) {
    const instant = new Date(dateTime);
    if (Number.isNaN(instant.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(instant);
    const part = type => parts.find(item => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  return dateTime.slice(0, 10);
}

function buildAulesGoogleEvent(event, existing = null) {
  const date = deadlineDate(event);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Una entrega de Aules no tiene DTSTART valido.');
  const summary = String(event.summary || '').startsWith('📚') ? String(event.summary) : `📚 ${event.summary || 'Entrega'}`;
  const deadline = originalDeadline(event);
  const descriptionParts = [];
  if (event.description) descriptionParts.push(event.description);
  descriptionParts.push('Origen: Aules');
  if (deadline) descriptionParts.push(`Fecha/hora límite original: ${deadline}`);
  const core = {
    summary,
    description: descriptionParts.join('\n\n'),
    location: event.location || undefined,
    start: { date },
    end: { date: addDay(date) },
    transparency: 'transparent',
    status: 'confirmed',
  };
  const fingerprint = sha1(JSON.stringify(core));
  return {
    ...core,
    extendedProperties: { private: {
      ...(existing?.extendedProperties?.private || {}),
      belenciagaAulesManaged: 'v1',
      belenciagaAulesUid: event.uid,
      belenciagaAulesFingerprint: fingerprint,
      belenciagaAulesOriginalStart: event.originalStart || deadline,
    } },
  };
}

async function listManagedEvents({ calendarId, token, request }) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      maxResults: '2500', showDeleted: 'false', singleEvents: 'false',
      privateExtendedProperty: 'belenciagaAulesManaged=v1',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await request('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${params}`, token);
    items.push(...(data?.items || []));
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return items;
}

async function importAules(options = {}) {
  const url = String(options.url ?? process.env.AULES_ICS_URL ?? '').trim();
  if (!url) return { source: 0, created: 0, updated: 0, unchanged: 0, skipped: 'missing_url' };

  const text = await fetchFeed(url, options.fetchOverride || fetch);
  const events = parseIcsEvents(text);
  const eventBlocks = (text.match(/(?:^|\r?\n)BEGIN:VEVENT(?:\r?\n|$)/gim) || []).length;
  if (eventBlocks !== events.length) {
    throw new Error('Aules contiene eventos ICS que no se pudieron interpretar.');
  }
  const byUid = new Map();
  for (const event of events) {
    if (byUid.has(event.uid)) throw new Error('El feed de Aules contiene UID duplicados.');
    byUid.set(event.uid, event);
  }

  const mapping = getTargetMapping();
  const token = options.tokenOverride || await googleAuth.getAccessToken();
  const request = options.googleRequestOverride || googleRequest;
  const existing = await listManagedEvents({ calendarId: mapping.googleCalendarId, token, request });
  const existingByUid = new Map();
  for (const event of existing) {
    const uid = event?.extendedProperties?.private?.belenciagaAulesUid;
    if (!uid) continue;
    if (existingByUid.has(uid)) throw new Error('Google contiene UID de Aules duplicados; no se aplicaron cambios.');
    existingByUid.set(uid, event);
  }

  const result = { source: events.length, created: 0, updated: 0, unchanged: 0, skipped: '' };
  const mutations = [];
  for (const event of events) {
    const current = existingByUid.get(event.uid) || null;
    const body = buildAulesGoogleEvent(event, current);
    if (!current) {
      result.created++;
      mutations.push(['POST', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events?sendUpdates=none`, body]);
    } else if (current.extendedProperties?.private?.belenciagaAulesFingerprint === body.extendedProperties.private.belenciagaAulesFingerprint) {
      result.unchanged++;
    } else {
      result.updated++;
      mutations.push(['PATCH', `/calendars/${encodeURIComponent(mapping.googleCalendarId)}/events/${encodeURIComponent(current.id)}?sendUpdates=none`, body]);
    }
  }
  if (!options.dryRun) {
    for (const [method, path, body] of mutations) await request(method, path, token, body);
  }
  if (options.dryRun && mutations.length) result.skipped = 'dry_run';
  return result;
}

module.exports = {
  importAules,
  _private: { normalizedCalendarName, getTargetMapping, deadlineDate, buildAulesGoogleEvent, fetchFeed },
};
