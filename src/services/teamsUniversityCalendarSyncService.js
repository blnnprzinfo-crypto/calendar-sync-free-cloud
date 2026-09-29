'use strict';

const { createHash, randomUUID } = require('node:crypto');
const icloud = require('./icloudCalDavService');
const microsoftAuth = require('./microsoftGraphAuthService');
const { googleEventToIcs, _private: { sourceKey } } = require('./calendarBidirectionalSyncService');
const { parseIcsEvents } = require('./calendarIcsEventParser');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const PROPERTY_GUID = '4f6d69f1-3f4a-4fd3-8bda-478d38c44d95';
const PROPERTY_IDS = Object.freeze({
  sourceKey: `String {${PROPERTY_GUID}} Name BelenciagaSourceKey`,
  uid: `String {${PROPERTY_GUID}} Name BelenciagaIcloudUid`,
  icloudFingerprint: `String {${PROPERTY_GUID}} Name BelenciagaIcloudFingerprint`,
  teamsFingerprint: `String {${PROPERTY_GUID}} Name BelenciagaTeamsFingerprint`,
});

function sha1(value) { return createHash('sha1').update(String(value)).digest('hex'); }

async function graphRequest(method, path, token, body = null, extraHeaders = {}) {
  const response = await fetch(path.startsWith('https:') ? path : `${GRAPH_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(`Microsoft Graph ${method} fallo (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function extensionValues(event) {
  const values = {};
  for (const property of event?.singleValueExtendedProperties || []) {
    for (const [key, id] of Object.entries(PROPERTY_IDS)) if (property.id === id) values[key] = property.value;
  }
  return values;
}

function extensionPayload(values) {
  return Object.entries(PROPERTY_IDS).map(([key, id]) => ({ id, value: String(values[key] || '') }));
}

function canonicalDate(value) {
  if (value?.date) return `date:${value.date}`;
  const raw = value?.dateTime || '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function portableFingerprint(event) {
  const localTime = value => value?.date ? `date:${value.date}` : String(value?.dateTime || '').slice(0, 19);
  return sha1(JSON.stringify({
    summary: String(event.summary || '').trim(),
    description: String(event.description || ''),
    location: String(event.location || ''),
    start: localTime(event.start),
    end: localTime(event.end),
    transparency: event.transparency === 'transparent' ? 'transparent' : 'opaque',
  }));
}

function isComplexGraphEvent(event) {
  return Boolean(event.recurrence || event.seriesMasterId)
    || ['occurrence', 'exception', 'seriesMaster'].includes(event.type);
}

function calendarRoot(calendarId) {
  return calendarId === 'primary' ? '/me/calendar' : `/me/calendars/${encodeURIComponent(calendarId)}`;
}

function hasMeetingMetadata(event) {
  return Boolean(event?.attendees?.length || event?.isOnlineMeeting || event?.onlineMeeting);
}

function hasIcloudMeetingMetadata(event) {
  return (event?.preservedProperties || []).some(line => /^(?:ATTENDEE|ORGANIZER)(?:;|:)/i.test(line));
}

function teamsFingerprint(event) {
  return sha1(JSON.stringify({
    summary: event.subject || '',
    description: event.body?.content || '',
    location: event.location?.displayName || '',
    start: event.start || null,
    end: event.end || null,
    allDay: Boolean(event.isAllDay),
    transparency: event.showAs === 'free' ? 'transparent' : 'opaque',
  }));
}

function icloudToGraph(event, extensions) {
  const allDay = Boolean(event.start?.date);
  const toGraphDate = value => ({
    dateTime: allDay ? `${value.date}T00:00:00` : value.dateTime,
    timeZone: value.timeZone || process.env.TZ || 'Europe/Madrid',
  });
  return {
    subject: event.summary || 'ocupado',
    body: { contentType: 'text', content: event.description || '' },
    location: { displayName: event.location || '' },
    start: toGraphDate(event.start),
    end: toGraphDate(event.end),
    isAllDay: allDay,
    showAs: event.transparency === 'transparent' ? 'free' : 'busy',
    singleValueExtendedProperties: extensionPayload(extensions),
  };
}

function graphToPortable(event) {
  const allDay = Boolean(event.isAllDay);
  const toPortable = value => allDay
    ? { date: String(value?.dateTime || '').slice(0, 10) }
    : { dateTime: value?.dateTime, timeZone: value?.timeZone || process.env.TZ || 'Europe/Madrid' };
  return {
    summary: event.subject || 'ocupado',
    description: event.body?.contentType === 'html'
      ? String(event.bodyPreview || '')
      : String(event.body?.content || ''),
    location: event.location?.displayName || '',
    start: toPortable(event.start),
    end: toPortable(event.end),
    transparency: event.showAs === 'free' ? 'transparent' : 'opaque',
    recurrence: [],
  };
}

function fingerprintGeneratedIcs(ics, calendar, uid) {
  return parseIcsEvents(ics, { calendarName: calendar.name, calendarUrl: calendar.url })
    .find(event => event.uid === uid)?.fingerprint || '';
}

async function listGraphEvents({ token, calendarId, start, end, request }) {
  const params = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    '$top': '1000',
    '$expand': 'singleValueExtendedProperties',
  });
  let path = `${calendarRoot(calendarId)}/calendarView?${params}`;
  const items = [];
  while (path) {
    const data = await request('GET', path, token);
    items.push(...(data?.value || []));
    path = data?.['@odata.nextLink'] || '';
  }
  return items;
}

function appleTimestamp(raw) {
  const match = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : 0;
}

async function syncUniversityTeams(options = {}) {
  if (process.env.TEAMS_UNIVERSITY_SYNC_ENABLED !== 'true' && !options.force) {
    return { enabled: false, counts: {}, operations: [] };
  }
  const calendarId = String(process.env.MICROSOFT_TEAMS_CALENDAR_ID || 'primary').trim();
  const calendarName = String(process.env.TEAMS_UNIVERSITY_ICLOUD_NAME || 'uni 🤓').normalize('NFC');
  const dryRun = options.dryRun ?? true;
  const request = options.graphRequestOverride || graphRequest;
  const token = options.tokenOverride || await microsoftAuth.getAccessToken();
  const now = options.now || new Date();
  const start = new Date(now); start.setDate(start.getDate() - 30);
  const end = new Date(now); end.setDate(end.getDate() + 365);
  const calendars = await icloud.discoverCalendars();
  const matches = calendars.filter(item => item.name.normalize('NFC') === calendarName);
  if (matches.length !== 1) throw new Error('El calendario iCloud universitario no existe de forma univoca.');
  const calendar = matches[0];
  const appleEvents = await icloud.fetchEventsFromCalendar(calendar, start, end);
  const graphEvents = await listGraphEvents({ token, calendarId, start, end, request });
  const graphByKey = new Map(graphEvents.map(item => [extensionValues(item).sourceKey, item]).filter(([key]) => key));
  const unlinkedGraph = graphEvents.filter(item => !extensionValues(item).sourceKey
    && !isComplexGraphEvent(item) && !hasMeetingMetadata(item) && !item.isCancelled);
  const consumedGraphIds = new Set();
  const appleKeys = new Set(appleEvents.map(item => item.sourceKey));
  const operations = [];

  for (const apple of appleEvents) {
    if (hasIcloudMeetingMetadata(apple)) {
      operations.push({ type: 'teams_skip_meeting_metadata' });
      continue;
    }
    if (apple.recurrenceId || apple.recurrence?.length) {
      operations.push({ type: 'teams_skip_complex_recurrence' });
      continue;
    }
    let graph = graphByKey.get(apple.sourceKey);
    if (!graph) {
      const sameContent = unlinkedGraph.filter(item => !consumedGraphIds.has(item.id)
        && portableFingerprint(graphToPortable(item)) === portableFingerprint(apple));
      if (sameContent.length > 1) {
        operations.push({ type: 'teams_skip_ambiguous_duplicate' });
        continue;
      }
      if (sameContent.length === 1) {
        graph = sameContent[0];
        consumedGraphIds.add(graph.id);
        operations.push({ type: 'teams_link_existing' });
        if (!dryRun) {
          await request('PATCH', `/me/events/${encodeURIComponent(graph.id)}`, token, {
            singleValueExtendedProperties: extensionPayload({
              sourceKey: apple.sourceKey, uid: apple.uid,
              icloudFingerprint: apple.fingerprint, teamsFingerprint: teamsFingerprint(graph),
            }),
          }, graph['@odata.etag'] ? { 'If-Match': graph['@odata.etag'] } : {});
        }
        continue;
      }
      operations.push({ type: 'teams_create' });
      if (!dryRun) {
        const initial = icloudToGraph(apple, {
          sourceKey: apple.sourceKey, uid: apple.uid,
          icloudFingerprint: apple.fingerprint, teamsFingerprint: '',
        });
        const created = await request('POST', `${calendarRoot(calendarId)}/events`, token, initial);
        if (created?.id) {
          await request('PATCH', `/me/events/${encodeURIComponent(created.id)}`, token, {
            singleValueExtendedProperties: extensionPayload({
              sourceKey: apple.sourceKey, uid: apple.uid,
              icloudFingerprint: apple.fingerprint, teamsFingerprint: teamsFingerprint(created || initial),
            }),
          }, created['@odata.etag'] ? { 'If-Match': created['@odata.etag'] } : {});
        }
      }
      continue;
    }
    graphByKey.delete(apple.sourceKey);
    if (hasMeetingMetadata(graph)) {
      operations.push({ type: 'teams_skip_meeting_metadata' });
      continue;
    }
    if (isComplexGraphEvent(graph)) {
      operations.push({ type: 'teams_skip_complex_recurrence' });
      continue;
    }
    const props = extensionValues(graph);
    const appleChanged = props.icloudFingerprint !== apple.fingerprint;
    const graphCurrent = teamsFingerprint(graph);
    const graphChanged = Boolean(props.teamsFingerprint) && props.teamsFingerprint !== graphCurrent;
    if (!appleChanged && !graphChanged) {
      operations.push({ type: 'teams_skip_unchanged' });
      continue;
    }
    const graphWins = graphChanged && (!appleChanged
      || Date.parse(graph.lastModifiedDateTime || '') > appleTimestamp(apple.lastModified));
    if (graphWins) {
      operations.push({ type: 'teams_update_icloud' });
      if (!dryRun) {
        const portable = graphToPortable(graph);
        const ics = googleEventToIcs(portable, apple.uid, apple.alarms, apple.preservedProperties);
        const expectedAppleFingerprint = fingerprintGeneratedIcs(ics, calendar, apple.uid);
        await icloud.putCalendarObject({
          url: apple.href, etag: apple.etag,
          ics,
        });
        await request('PATCH', `/me/events/${encodeURIComponent(graph.id)}`, token, {
          singleValueExtendedProperties: extensionPayload({
            ...props, icloudFingerprint: expectedAppleFingerprint, teamsFingerprint: graphCurrent,
          }),
        }, graph['@odata.etag'] ? { 'If-Match': graph['@odata.etag'] } : {});
      }
    } else {
      operations.push({ type: 'teams_update' });
      if (!dryRun) {
        const desired = icloudToGraph(apple, {
          ...props, icloudFingerprint: apple.fingerprint, teamsFingerprint: '',
        });
        desired.singleValueExtendedProperties = extensionPayload({
          ...props, icloudFingerprint: apple.fingerprint, teamsFingerprint: teamsFingerprint(desired),
        });
        await request('PATCH', `/me/events/${encodeURIComponent(graph.id)}`, token, desired,
          graph['@odata.etag'] ? { 'If-Match': graph['@odata.etag'] } : {});
      }
    }
  }

  for (const graph of graphEvents) {
    const props = extensionValues(graph);
    if (props.sourceKey || consumedGraphIds.has(graph.id) || isComplexGraphEvent(graph)
        || hasMeetingMetadata(graph) || graph.isCancelled) continue;
    const uid = `belenciaga-teams-${randomUUID()}@calendar-sync`;
    const key = sourceKey(calendar.url, uid);
    if (appleKeys.has(key)) continue;
    operations.push({ type: 'teams_create_icloud' });
    if (!dryRun) {
      const ics = googleEventToIcs(graphToPortable(graph), uid);
      const expectedAppleFingerprint = fingerprintGeneratedIcs(ics, calendar, uid);
      await icloud.putCalendarObject({
        url: new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href,
        ics, createOnly: true,
      });
      await request('PATCH', `/me/events/${encodeURIComponent(graph.id)}`, token, {
        singleValueExtendedProperties: extensionPayload({
          sourceKey: key, uid, icloudFingerprint: expectedAppleFingerprint, teamsFingerprint: teamsFingerprint(graph),
        }),
      }, graph['@odata.etag'] ? { 'If-Match': graph['@odata.etag'] } : {});
    }
  }
  const counts = {};
  for (const item of operations) counts[item.type] = (counts[item.type] || 0) + 1;
  return { enabled: true, dryRun, counts, operations };
}

module.exports = {
  syncUniversityTeams,
  graphRequest,
  _private: { PROPERTY_IDS, extensionValues, extensionPayload, teamsFingerprint, icloudToGraph, graphToPortable, canonicalDate, portableFingerprint, isComplexGraphEvent, hasMeetingMetadata, hasIcloudMeetingMetadata, calendarRoot },
};
