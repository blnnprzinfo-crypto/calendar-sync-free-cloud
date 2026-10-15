'use strict';
const assert = require('node:assert/strict');
const { civilDate, matches, assertSingleInstance } = require('../../../PRODUCTION/maintenance/cleanup-cuenca-friday-20261016');
const friday = { summary: '🍔 ELEGIDO · Comer en Vibra Burger',
  start: { dateTime: '2026-10-16T14:00:00+02:00' } };
assert.equal(civilDate(friday), '2026-10-16');
assert.equal(matches(friday), true);
assert.equal(matches({ ...friday, summary: 'Otro evento de trabajo' }), false);
assert.equal(matches({ ...friday, start: { dateTime: '2026-10-17T14:00:00+02:00' } }), false);
assert.equal(matches({ ...friday, start: { dateTime: '2026-10-16T23:30:00Z' } }), false);
assert.equal(matches({ summary: 'CONFIRMADO · Apartamento Blanca, Alfonso VIII 20',
  start: { date: '2026-10-16' } }), true);
assert.doesNotThrow(() => assertSingleInstance(friday));
assert.throws(() => assertSingleInstance({ ...friday, recurrence: ['RRULE:FREQ=DAILY'] }), /repeating/);
assert.throws(() => assertSingleInstance({ ...friday, recurringEventId: 'parent' }), /repeating/);
console.log('OK cleanup Cuenca: exact titles, Madrid civil dates, recurrence safety');
