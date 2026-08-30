'use strict';

const { XMLParser } = require('fast-xml-parser');
const { parseIcsEvents } = require('./calendarIcsEventParser');

const DEFAULT_BASE_URL = 'https://caldav.icloud.com/';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in value) return String(value['#text'] || '');
  return '';
}

function hrefValue(value) {
  const first = asArray(value)[0];
  return textValue(first);
}

function normalizeUrl(baseUrl, href) {
  return new URL(href, baseUrl).href;
}

function getBaseUrl() {
  const raw = process.env.ICLOUD_CALDAV_BASE_URL || DEFAULT_BASE_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function getBasicAuthHeader() {
  const user = process.env.ICLOUD_USERNAME || '';
  const pass = process.env.ICLOUD_APP_PASSWORD || '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function toCalDavUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseMultistatus(xml) {
  const parsed = parser.parse(xml);
  const root = parsed.multistatus || parsed['D:multistatus'] || parsed;
  return asArray(root.response);
}

function responseProp(response, name) {
  for (const propstat of asArray(response.propstat)) {
    const status = textValue(propstat.status);
    if (status && !status.includes(' 200 ')) continue;
    const prop = propstat.prop || {};
    if (prop[name] !== undefined) return prop[name];
  }
  return undefined;
}

function hasCalendarResource(response) {
  const resource = responseProp(response, 'resourcetype');
  if (!resource || typeof resource !== 'object') return false;
  return resource.calendar !== undefined;
}

function supportsEvents(response) {
  const supported = responseProp(response, 'supported-calendar-component-set');
  if (!supported) return true;

  const comps = asArray(supported.comp);
  if (comps.length === 0) return true;
  return comps.some(comp => String(comp['@_name'] || '').toUpperCase() === 'VEVENT');
}

async function caldavRequest(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: getBasicAuthHeader(),
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: headers.Depth || '0',
      Prefer: 'return-minimal',
      ...headers,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`iCloud CalDAV ${method} failed (${res.status})`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return text;
}

async function putCalendarObject({ url, ics, etag = '', createOnly = false }) {
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    Depth: '0',
  };
  if (createOnly) headers['If-None-Match'] = '*';
  else if (etag) headers['If-Match'] = etag;
  await caldavRequest('PUT', url, ics, headers);
  return { ok: true, url };
}

async function deleteCalendarObject({ url, etag = '' }) {
  const headers = { Depth: '0' };
  if (etag) headers['If-Match'] = etag;
  await caldavRequest('DELETE', url, null, headers);
  return { ok: true, url };
}

async function propfind(url, props, depth = '0') {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>${props}</d:prop>
</d:propfind>`;
  return caldavRequest('PROPFIND', url, body, { Depth: depth });
}

async function calendarReport(url, start, end) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toCalDavUtc(start)}" end="${toCalDavUtc(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  return caldavRequest('REPORT', url, body, { Depth: '1' });
}

function validateConfig() {
  const missing = [];
  if (!process.env.ICLOUD_USERNAME) missing.push('ICLOUD_USERNAME');
  if (!process.env.ICLOUD_APP_PASSWORD) missing.push('ICLOUD_APP_PASSWORD');

  const calendarUrls = splitList(process.env.ICLOUD_CALENDAR_URLS);
  const calendarNames = splitList(process.env.ICLOUD_CALENDAR_NAMES);
  const syncAll = process.env.ICLOUD_SYNC_ALL_CALENDARS === 'true';
  if (calendarUrls.length === 0 && calendarNames.length === 0 && !syncAll) {
    missing.push('ICLOUD_CALENDAR_NAMES o ICLOUD_CALENDAR_URLS o ICLOUD_SYNC_ALL_CALENDARS=true');
  }

  return { ok: missing.length === 0, missing };
}

async function discoverPrincipal(baseUrl) {
  const props = '<d:current-user-principal/>';
  const candidates = [
    baseUrl,
    normalizeUrl(baseUrl, '/.well-known/caldav'),
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      const xml = await propfind(url, props, '0');
      const [response] = parseMultistatus(xml);
      const href = hrefValue(responseProp(response, 'current-user-principal')?.href);
      if (href) return normalizeUrl(baseUrl, href);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('No se pudo descubrir current-user-principal en iCloud CalDAV.');
}

async function discoverCalendarHome(baseUrl, principalUrl) {
  const xml = await propfind(principalUrl, '<c:calendar-home-set/>', '0');
  const [response] = parseMultistatus(xml);
  const href = hrefValue(responseProp(response, 'calendar-home-set')?.href);
  if (!href) throw new Error('iCloud CalDAV no devolvio calendar-home-set.');
  return normalizeUrl(baseUrl, href);
}

async function discoverCalendars() {
  const baseUrl = getBaseUrl();
  const principalUrl = await discoverPrincipal(baseUrl);
  const homeUrl = await discoverCalendarHome(baseUrl, principalUrl);
  const xml = await propfind(homeUrl, [
    '<d:displayname/>',
    '<d:resourcetype/>',
    '<c:supported-calendar-component-set/>',
  ].join(''), '1');

  const responses = parseMultistatus(xml);
  return responses
    .filter(response => hasCalendarResource(response) && supportsEvents(response))
    .map(response => {
      const href = hrefValue(response.href);
      return {
        name: textValue(responseProp(response, 'displayname')) || '(sin nombre)',
        url: normalizeUrl(baseUrl, href),
      };
    });
}

async function getSelectedCalendars() {
  const configuredUrls = splitList(process.env.ICLOUD_CALENDAR_URLS);
  if (configuredUrls.length > 0) {
    return configuredUrls.map((url, index) => ({
      name: `icloud-${index + 1}`,
      url: normalizeUrl(getBaseUrl(), url),
    }));
  }

  const discovered = await discoverCalendars();
  const names = splitList(process.env.ICLOUD_CALENDAR_NAMES).map(x => x.toLowerCase());
  if (names.length === 0 && process.env.ICLOUD_SYNC_ALL_CALENDARS === 'true') return discovered;

  const selected = discovered.filter(calendar => names.includes(calendar.name.toLowerCase()));
  if (selected.length === 0) {
    throw new Error('No se encontro ningun calendario iCloud con los nombres configurados.');
  }
  return selected;
}

async function fetchEventsFromCalendar(calendar, start, end) {
  const xml = await calendarReport(calendar.url, start, end);
  const responses = parseMultistatus(xml);
  const events = [];

  for (const response of responses) {
    const calendarData = textValue(responseProp(response, 'calendar-data'));
    if (!calendarData) continue;

    const parsed = parseIcsEvents(calendarData, {
      calendarName: calendar.name,
      calendarUrl: calendar.url,
      href: normalizeUrl(calendar.url, hrefValue(response.href)),
      etag: textValue(responseProp(response, 'getetag')),
      defaultTimeZone: process.env.TZ || 'Europe/Madrid',
    });

    events.push(...parsed);
  }

  return events;
}

async function fetchIcloudEvents({ start, end } = {}) {
  const validation = validateConfig();
  if (!validation.ok) {
    const err = new Error(`Configuracion iCloud incompleta: ${validation.missing.join(', ')}`);
    err.code = 'ICLOUD_CONFIG_INCOMPLETA';
    err.missing = validation.missing;
    throw err;
  }

  const calendars = await getSelectedCalendars();
  const allEvents = [];
  for (const calendar of calendars) {
    const events = await fetchEventsFromCalendar(calendar, start, end);
    allEvents.push(...events);
  }

  return { calendars, events: allEvents };
}

module.exports = {
  validateConfig,
  discoverCalendars,
  getSelectedCalendars,
  fetchEventsFromCalendar,
  fetchIcloudEvents,
  putCalendarObject,
  deleteCalendarObject,
  _private: {
    caldavRequest,
    calendarReport,
    discoverPrincipal,
    discoverCalendarHome,
    parseMultistatus,
    responseProp,
    toCalDavUtc,
  },
};
