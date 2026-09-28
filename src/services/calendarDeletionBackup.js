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
  const privateData = {
    deletionBackup: 'v1', checksum, chunks: String(chunks.length),
    // Legibles sin descomprimir, solo para listar respaldos candidatos a restaurar.
    originalSummary: String(appleEvent.summary || '').slice(0, 200),
    originalStart: JSON.stringify(appleEvent.start || {}).slice(0, 200),
    deletedAt: new Date().toISOString(),
  };
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

// Enumera los respaldos disponibles en el calendario tecnico sin tener que
// descomprimir cada uno: se apoya en los campos legibles que backupBeforeDeletion
// guarda ademas de los fragmentos comprimidos.
async function listDeletionBackups({ calendarId, token, request }) {
  if (!calendarId) throw new Error('Falta calendario tecnico para listar respaldos.');
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: 'deletionBackup=v1', maxResults: '250', showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await request('GET', `${base}?${params}`, token);
    for (const event of data?.items || []) {
      const props = event.extendedProperties?.private || {};
      items.push({
        id: event.id,
        summary: props.originalSummary || '(sin titulo)',
        start: props.originalStart || '',
        deletedAt: props.deletedAt || '',
      });
    }
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return items;
}

// Restaura un respaldo en iCloud. Usa semantica create-only (If-None-Match: *)
// para no pisar nunca un evento mas reciente que exista en el mismo href.
async function restoreFromDeletionBackup({ backupId, calendarId, token, request, putIcloudObject }) {
  if (!calendarId) throw new Error('Falta calendario tecnico para leer el respaldo.');
  if (!backupId) throw new Error('Falta el id del respaldo a restaurar.');
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const saved = await request('GET', `${base}/${backupId}`, token);
  const props = saved?.extendedProperties?.private || {};
  if (props.deletionBackup !== 'v1') {
    throw new Error(`El evento ${backupId} no es un respaldo de borrado valido.`);
  }
  const chunkCount = Number(props.chunks);
  if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
    throw new Error('Respaldo corrupto: numero de fragmentos invalido.');
  }
  const packed = Array.from({ length: chunkCount }, (_, index) => props[`data${index}`] || '').join('');
  let payload;
  try {
    payload = gunzipSync(Buffer.from(packed, 'base64')).toString();
  } catch (_) {
    throw new Error('Respaldo corrupto: no se pudo descomprimir; restauracion abortada.');
  }
  if (digest(payload) !== props.checksum) {
    throw new Error('Checksum del respaldo no coincide; restauracion abortada.');
  }
  const data = JSON.parse(payload);
  await putIcloudObject({ url: data.href, ics: data.ics, createOnly: true });
  return data;
}

module.exports = { backupBeforeDeletion, listDeletionBackups, restoreFromDeletionBackup };
