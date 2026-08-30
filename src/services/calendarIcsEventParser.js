'use strict';

const { createHash } = require('node:crypto');

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function unfoldIcsLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
      return lines;
    }, []);
}

function unescapeIcsText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parsePropertyLine(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;

  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [nameRaw, ...paramParts] = left.split(';');
  const params = {};

  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }

  return {
    name: nameRaw.toUpperCase(),
    params,
    value,
  };
}

function toIsoDate(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function toLocalDateTime(raw) {
  const seconds = raw.slice(13, 15) || '00';
  return `${toIsoDate(raw)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${seconds}`;
}

function parseIcsDateForGoogle(prop, defaultTimeZone = 'Europe/Madrid') {
  if (!prop || !prop.value) return null;
  const raw = String(prop.value).trim();

  if (prop.params?.VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
    return { date: toIsoDate(raw) };
  }

  if (!/^\d{8}T\d{4}(\d{2})?Z?$/.test(raw)) return null;

  if (raw.endsWith('Z')) {
    const normalized = raw.length === 14
      ? raw.replace(/^(\d{8}T\d{4})Z$/, '$100Z')
      : raw;
    const y = Number(normalized.slice(0, 4));
    const month = Number(normalized.slice(4, 6)) - 1;
    const d = Number(normalized.slice(6, 8));
    const h = Number(normalized.slice(9, 11));
    const m = Number(normalized.slice(11, 13));
    const s = Number(normalized.slice(13, 15));
    return { dateTime: new Date(Date.UTC(y, month, d, h, m, s)).toISOString() };
  }

  const local = raw.length === 13 ? `${raw}00` : raw;
  return {
    dateTime: toLocalDateTime(local),
    timeZone: prop.params?.TZID || defaultTimeZone,
  };
}

function addHoursToGoogleStart(start, hours, defaultTimeZone = 'Europe/Madrid') {
  if (!start) return null;
  if (start.date) return { date: start.date };

  if (start.dateTime && start.dateTime.endsWith('Z')) {
    return { dateTime: new Date(Date.parse(start.dateTime) + hours * 60 * 60_000).toISOString() };
  }

  const date = new Date(start.dateTime);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(date.getHours() + hours);
  return {
    dateTime: `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`,
    timeZone: start.timeZone || defaultTimeZone,
  };
}

function parseDurationHours(prop) {
  const raw = String(prop?.value || '').trim();
  const m = raw.match(/^P(?:\d+D)?T?(\d+)H/i);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function getFirst(raw, name) {
  return asArray(raw[name]).find(Boolean) || null;
}

function getAll(raw, name) {
  return asArray(raw[name]).filter(Boolean);
}

function normalizeEvent(raw, meta = {}) {
  const uid = unescapeIcsText(getFirst(raw, 'UID')?.value || '');
  if (!uid) return null;

  const timeZone = meta.defaultTimeZone || process.env.TZ || 'Europe/Madrid';
  const start = parseIcsDateForGoogle(getFirst(raw, 'DTSTART'), timeZone);
  let end = parseIcsDateForGoogle(getFirst(raw, 'DTEND'), timeZone);

  if (!end) {
    const durationHours = parseDurationHours(getFirst(raw, 'DURATION'));
    end = durationHours ? addHoursToGoogleStart(start, durationHours, timeZone) : addHoursToGoogleStart(start, 1, timeZone);
  }

  const recurrence = [];
  for (const prop of getAll(raw, 'RRULE')) recurrence.push(`RRULE:${prop.value}`);
  for (const prop of getAll(raw, 'EXDATE')) recurrence.push(`EXDATE:${prop.value}`);

  const event = {
    uid,
    summary: unescapeIcsText(getFirst(raw, 'SUMMARY')?.value || 'ocupado'),
    description: unescapeIcsText(getFirst(raw, 'DESCRIPTION')?.value || ''),
    location: unescapeIcsText(getFirst(raw, 'LOCATION')?.value || ''),
    status: String(getFirst(raw, 'STATUS')?.value || '').toLowerCase(),
    sequence: Number.parseInt(getFirst(raw, 'SEQUENCE')?.value || '0', 10) || 0,
    lastModified: getFirst(raw, 'LAST-MODIFIED')?.value || getFirst(raw, 'DTSTAMP')?.value || '',
    start,
    end,
    recurrence,
    calendarName: meta.calendarName || '',
    calendarUrl: meta.calendarUrl || '',
    href: meta.href || '',
    etag: meta.etag || '',
  };

  const sourceBase = event.calendarUrl || event.calendarName || 'icloud';
  event.sourceKey = sha1(`${sourceBase}|${event.uid}`);
  event.fingerprint = sha1(JSON.stringify({
    uid: event.uid,
    summary: event.summary,
    description: event.description,
    location: event.location,
    status: event.status,
    sequence: event.sequence,
    lastModified: event.lastModified,
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
    etag: event.etag,
  }));

  return event;
}

function parseIcsEvents(text, meta = {}) {
  const lines = unfoldIcsLines(text);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const event = normalizeEvent(current, meta);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parsePropertyLine(line);
    if (!prop) continue;
    if (!current[prop.name]) current[prop.name] = [];
    current[prop.name].push(prop);
  }

  return events;
}

module.exports = {
  parseIcsEvents,
  parseIcsDateForGoogle,
  parsePropertyLine,
  unfoldIcsLines,
  unescapeIcsText,
};
