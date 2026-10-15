'use strict';
// Read-only integrity audit: September 15-18, 2026 Scotland trip in plans calendar.
// No event names, locations, descriptions, identifiers or secrets are logged.
require('dotenv').config();
const googleAuth = require('../../src/services/googleCalendarAuthService');
const icloud = require('../../src/services/icloudCalDavService');
const { getCalendarMap, _private: { normalizeName, canonicalTime } } =
  require('../../src/services/calendarBidirectionalSyncService');
const START = new Date('2026-09-14T22:00:00Z');
const END = new Date('2026-09-19T00:00:00Z');
const EXPECTED_GOOGLE = 'adb50694b3065cfe8bea3d5139a081f827be2c0c5e6060d14399fd7d6f33ab6b@group.calendar.google.com';
const BASE = 'https://www.googleapis.com/calendar/v3';
function key(item) {
  return [String(item.summary || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es'),
    canonicalTime(item.start), canonicalTime(item.end)].join('|');
}
function count(list) {
  const map = new Map();
  for (const item of list) map.set(key(item), (map.get(key(item)) || 0) + 1);
  return map;
}
function day(event) {
  if (event.start?.date) return event.start.date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(event.start.dateTime));
}
async function googleList(calendarId) {
  const token = await googleAuth.getAccessToken();
  let page = '';
  const items = [];
  do {
    const q = new URLSearchParams({ timeMin: START.toISOString(), timeMax: END.toISOString(),
      maxResults: '2500', showDeleted: 'false', singleEvents: 'false' });
    if (page) q.set('pageToken', page);
    const response = await fetch(BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events?' + q, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Google read failed HTTP ' + response.status);
    const data = await response.json();
    items.push(...(data.items || []));
    page = data.nextPageToken || '';
  } while (page);
  return items.filter(x => x.status !== 'cancelled');
}
async function main() {
  const mapping = getCalendarMap().filter(x => normalizeName(x.icloudName).startsWith('planes'));
  if (mapping.length !== 1 || mapping[0].googleCalendarId !== EXPECTED_GOOGLE)
    throw new Error('Unexpected calendar mapping; no audit');
  const calendars = (await icloud.discoverCalendars()).filter(x => normalizeName(x.name) === normalizeName(mapping[0].icloudName));
  if (calendars.length !== 1) throw new Error('No unique iCloud plans calendar');
  async function fetchAppleWithRetry() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await icloud.fetchEventsFromCalendar(calendars[0], START, END); }
      catch (error) {
        if (![429, 502, 503, 504].includes(error.status) || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    }
  }
  const [apple, google] = await Promise.all([
    fetchAppleWithRetry(), googleList(EXPECTED_GOOGLE),
  ]);
  const am = count(apple), gm = count(google);
  const unmatchedGoogle = [], unmatchedApple = [];
  const seenGoogle = new Map();
  for (const g of google) {
    const k = key(g), nth = seenGoogle.get(k) || 0;
    seenGoogle.set(k,nth+1);
    if (nth >= (am.get(k) || 0)) unmatchedGoogle.push(g);
  }
  const seenApple = new Map();
  for (const a of apple) {
    const k = key(a),nth=seenApple.get(k)||0;
    seenApple.set(k,nth+1);
    if (nth >= (gm.get(k) || 0)) unmatchedApple.push(a);
  }
  const byDate = list => {
    const tally = {};
    for (const x of list) tally[day(x)] = (tally[day(x)] || 0) + 1;
    return tally;
  };
  console.log(JSON.stringify({
    stage: 'READ_ONLY_SCOTLAND_AUDIT',
    appleTotal: apple.length, googleTotal: google.length,
    appleByDay: byDate(apple), googleByDay: byDate(google),
    onlyInGoogleTotal: unmatchedGoogle.length, onlyInGoogleByDay: byDate(unmatchedGoogle),
    onlyInIcloudTotal: unmatchedApple.length, onlyInIcloudByDay: byDate(unmatchedApple),
  }));
}
main().catch(error => { console.error('[read-only-audit] ' + error.message); process.exitCode=1; });
