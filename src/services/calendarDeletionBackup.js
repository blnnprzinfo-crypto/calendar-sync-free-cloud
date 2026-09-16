'use strict';

const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');

const digest = value => createHash('sha256').update(value).digest('hex');

// Persist the complete original in the existing technical Google calendar.
// Read it back before permitting any deletion; a local runner disk is not durable.
async function backupBeforeDeletion({ appleEvent, googleEvent, mapping, token, request, ics }) {
  const calendarId = process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  if (!calendarId) throw new Error('Falta calendario tecnico para guardar el respaldo del borrado.');
  const payload = JSON.stringify({ version: 1, href: appleEvent.href, etag: appleEvent.etag,
    sourceKey: appleEvent.sourceKey, googleCalendarId: mapping.googleCalendarId,
    googleEventId: googleEvent.id, ics });
  const packed = gzipSync(payload).toString('base64');
  if (packed.length > 28000) throw new Error('Respaldo demasiado grande: se conserva el evento iCloud.');
  const checksum = digest(payload);
  const chunks = packed.match(/.{1,1000}/g);
  const id = `de1${digest(`${appleEvent.sourceKey}|${appleEvent.etag}|${googleEvent.id}`).slice(0, 48)}`;
  const privateData = { deletionBackup: 'v1', checksum, chunks: String(chunks.length) };
  chunks.forEach((chunk, index) => { privateData[`data${index}`] = chunk; });
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    await request('POST', `${base}?sendUpdates=none`, token, {
      id, summary: '[tecnico] Respaldo de evento eliminado',
      start: { date: '2000-01-01' }, end: { date: '2000-01-02' },
      visibility: 'private', transparency: 'transparent',
      extendedProperties: { private: privateData },
    });
  } catch (error) { if (error.status !== 409) throw error; }
  const saved = await request('GET', `${base}/${id}`, token);
  const props = saved?.extendedProperties?.private || {};
  if (saved?.status === 'cancelled' || props.deletionBackup !== 'v1'
      || props.checksum !== checksum || props.chunks !== String(chunks.length)) {
    throw new Error('Respaldo de borrado no verificable; iCloud se conserva.');
  }
  const decoded = gunzipSync(Buffer.from(chunks.map((_, index) => props[`data${index}`] || '').join(''), 'base64')).toString();
  if (decoded !== payload || digest(decoded) !== checksum) throw new Error('Respaldo incompleto; iCloud se conserva.');
  return id;
}

module.exports = { backupBeforeDeletion };
