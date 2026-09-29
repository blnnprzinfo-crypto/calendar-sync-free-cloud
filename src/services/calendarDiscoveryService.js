'use strict';

const TECHNICAL_NAME = /(?:^|[\s_-])(sync[-\s_]?lock|locks?|technical|backups?|bridge[-\s_]?internal)(?:$|[\s_-])/i;

function normalizeName(value) {
  return String(value || '').trim().normalize('NFC').toLocaleLowerCase('es');
}

function parseStringList(raw, label) {
  if (!String(raw || '').trim()) return [];
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    throw new Error(`${label} no es JSON valido: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} debe ser un array JSON de textos.`);
  }
  return value.map(item => item.trim()).filter(Boolean);
}

function isTechnical(calendar, options = {}) {
  const id = String(calendar.id || calendar.url || '');
  const name = String(calendar.summary || calendar.name || '');
  return (options.technicalIds || []).includes(id) || TECHNICAL_NAME.test(name);
}

function isGoogleEditable(calendar) {
  return calendar.accessRole === 'owner' || calendar.accessRole === 'writer';
}

async function listGoogleCalendars({ token, request }) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ maxResults: '250', showHidden: 'true' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await request('GET', `/users/me/calendarList?${params}`, token);
    items.push(...(data?.items || []));
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return items;
}

function groupByName(items, nameOf) {
  const groups = new Map();
  for (const item of items) {
    const key = normalizeName(nameOf(item));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function buildDiscoveryPlan(options) {
  const denylist = new Set((options.denylist || []).map(normalizeName));
  const technicalIds = options.technicalIds || [];
  const overrides = options.overrides || {};
  const icloud = (options.icloudCalendars || []).filter(calendar => {
    return !isTechnical(calendar, { technicalIds })
      && !denylist.has(normalizeName(calendar.name))
      && !denylist.has(normalizeName(calendar.url));
  });
  const google = (options.googleCalendars || []).filter(calendar => {
    return !isTechnical(calendar, { technicalIds })
      && !denylist.has(normalizeName(calendar.summary))
      && !denylist.has(normalizeName(calendar.id));
  });
  const icloudGroups = groupByName(icloud, item => item.name);
  const googleGroups = groupByName(google, item => item.summary);
  const mappings = [];
  const createGoogle = [];
  const createIcloud = [];
  const diagnostics = [];
  const consumedGoogle = new Set();
  const consumedIcloud = new Set();

  const ambiguousNames = new Set();
  for (const [key, items] of icloudGroups) if (items.length > 1) ambiguousNames.add(key);
  for (const [key, items] of googleGroups) if (items.length > 1) ambiguousNames.add(key);
  for (const key of ambiguousNames) diagnostics.push({ severity: 'error', code: 'ambiguous_same_name' });

  for (const [icloudName, googleId] of Object.entries(overrides)) {
    const overrideName = normalizeName(icloudName);
    if (ambiguousNames.has(overrideName)) continue;
    const apple = icloud.find(item => normalizeName(item.name) === overrideName);
    const target = google.find(item => item.id === googleId);
    if (!apple || !target) {
      diagnostics.push({ severity: 'error', code: 'invalid_manual_override' });
      continue;
    }
    if (!isGoogleEditable(target)) {
      diagnostics.push({ severity: 'error', code: 'manual_target_read_only' });
      continue;
    }
    mappings.push({ icloudName: apple.name, googleCalendarId: target.id, source: 'manual' });
    consumedIcloud.add(apple.url);
    consumedGoogle.add(target.id);
  }

  for (const [key, apples] of icloudGroups) {
    if (ambiguousNames.has(key)) continue;
    if (apples.some(item => consumedIcloud.has(item.url))) continue;
    const candidates = googleGroups.get(key) || [];
    const apple = apples[0];
    const target = candidates[0];
    if (target) {
      consumedGoogle.add(target.id);
      consumedIcloud.add(apple.url);
      if (isGoogleEditable(target)) {
        mappings.push({ icloudName: apple.name, googleCalendarId: target.id, source: 'name' });
      } else {
        diagnostics.push({ severity: 'error', code: 'same_name_read_only' });
      }
      continue;
    }
    if (options.authMode === 'oauth' && options.createMissing) {
      createGoogle.push({ name: apple.name, icloudUrl: apple.url });
    } else {
      diagnostics.push({ severity: 'warning', code: options.authMode === 'oauth'
        ? 'google_creation_disabled'
        : 'google_creation_requires_oauth' });
    }
  }

  for (const target of google) {
    if (consumedGoogle.has(target.id) || ambiguousNames.has(normalizeName(target.summary))) continue;
    if (!isGoogleEditable(target)) {
      diagnostics.push({ severity: 'warning', code: 'google_calendar_read_only' });
      continue;
    }
    if (options.createMissing) createIcloud.push({ name: target.summary, googleCalendarId: target.id });
    else diagnostics.push({ severity: 'warning', code: 'icloud_creation_disabled' });
  }

  return { mappings, createGoogle, createIcloud, diagnostics };
}

function readDiscoveryConfig() {
  let overrides = {};
  const rawMap = String(process.env.CALENDAR_SYNC_MAP_JSON || '').trim();
  if (rawMap) {
    try { overrides = JSON.parse(rawMap); } catch (error) {
      throw new Error(`CALENDAR_SYNC_MAP_JSON no es JSON valido: ${error.message}`);
    }
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') {
      throw new Error('CALENDAR_SYNC_MAP_JSON debe ser un objeto de overrides.');
    }
  }
  return {
    overrides,
    denylist: parseStringList(process.env.CALENDAR_SYNC_DENYLIST_JSON, 'CALENDAR_SYNC_DENYLIST_JSON'),
    technicalIds: [process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID, process.env.CALENDAR_SYNC_BACKUP_CALENDAR_ID].filter(Boolean),
    authMode: String(process.env.GOOGLE_CALENDAR_AUTH_MODE || 'service_account').toLowerCase(),
    createMissing: process.env.CALENDAR_SYNC_CREATE_MISSING_CALENDARS === 'true',
  };
}

module.exports = {
  normalizeName,
  isTechnical,
  isGoogleEditable,
  listGoogleCalendars,
  buildDiscoveryPlan,
  readDiscoveryConfig,
};
