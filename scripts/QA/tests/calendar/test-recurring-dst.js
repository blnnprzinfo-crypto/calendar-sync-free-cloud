'use strict';
const assert = require('node:assert/strict');
const { googleEventToIcs } = require('../../../../src/services/calendarBidirectionalSyncService');
const recurring = {
  summary: 'Imagen Global DG',
  start: { dateTime: '2026-10-20T09:40:00+02:00', timeZone: 'Europe/Madrid' },
  end: { dateTime: '2026-10-20T10:30:00+02:00', timeZone: 'Europe/Madrid' },
  recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20270201T235959Z',
    'EXDATE;TZID=Europe/Madrid:20261208T094000'],
};
const ics = googleEventToIcs(recurring, 'dst-weekly-test');
assert.match(ics, /DTSTART;TZID=Europe\/Madrid:20261020T094000/);
assert.match(ics, /DTEND;TZID=Europe\/Madrid:20261020T103000/);
assert.match(ics, /EXDATE;TZID=Europe\/Madrid:20261208T094000/);
assert.doesNotMatch(ics, /DTSTART:20261020T074000Z/);
const winter = googleEventToIcs({
  ...recurring,
  start: { dateTime: '2026-10-27T09:40:00+01:00', timeZone: 'Europe/Madrid' },
  end: { dateTime: '2026-10-27T10:30:00+01:00', timeZone: 'Europe/Madrid' },
}, 'dst-winter-test');
assert.match(winter, /DTSTART;TZID=Europe\/Madrid:20261027T094000/);
assert.match(winter, /DTEND;TZID=Europe\/Madrid:20261027T103000/);
console.log('Recurring DST serialization: OK');
