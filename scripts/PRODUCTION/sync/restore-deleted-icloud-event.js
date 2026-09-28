'use strict';

require('dotenv').config();

const googleAuth = require('../../../src/services/googleCalendarAuthService');
const icloud = require('../../../src/services/icloudCalDavService');
const { listDeletionBackups, restoreFromDeletionBackup } = require('../../../src/services/calendarDeletionBackup');

const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3';

async function googleRequest(method, path, token) {
  const response = await fetch(`${GOOGLE_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Google Calendar ${method} fallo (${response.status}): ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

function has(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const calendarId = process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID;
  if (!calendarId) throw new Error('Falta CALENDAR_SYNC_LOCK_CALENDAR_ID.');
  const token = await googleAuth.getAccessToken();

  if (has('--list')) {
    const backups = await listDeletionBackups({ calendarId, token, request: googleRequest });
    if (backups.length === 0) {
      console.log('[restore] No hay respaldos de borrado disponibles.');
      return;
    }
    console.log(`[restore] ${backups.length} respaldo(s) disponible(s):`);
    for (const backup of backups) {
      console.log(`  ${backup.id}  |  ${backup.summary}  |  inicio: ${backup.start}  |  borrado: ${backup.deletedAt}`);
    }
    console.log('\nUsa --id <id> para ver el detalle, o --id <id> --apply para restaurar.');
    return;
  }

  const backupId = argValue('--id');
  if (!backupId) {
    throw new Error('Usa --list para ver los respaldos disponibles, o --id <id> [--apply] para restaurar uno.');
  }

  if (!has('--apply')) {
    const backups = await listDeletionBackups({ calendarId, token, request: googleRequest });
    const match = backups.find(backup => backup.id === backupId);
    if (!match) throw new Error(`No se encontro el respaldo ${backupId}.`);
    console.log('[restore] Vista previa (no se ha escrito nada):');
    console.log(`  id: ${match.id}`);
    console.log(`  titulo original: ${match.summary}`);
    console.log(`  inicio original: ${match.start}`);
    console.log(`  borrado: ${match.deletedAt}`);
    console.log('\nRepite con --apply para restaurar el evento en iCloud.');
    return;
  }

  const restored = await restoreFromDeletionBackup({
    backupId, calendarId, token, request: googleRequest, putIcloudObject: icloud.putCalendarObject,
  });
  console.log(`[restore] OK. Evento restaurado en iCloud: ${restored.href}`);
}

main().catch(error => {
  console.error(`[restore] ERROR ${error.message}`);
  process.exit(1);
});
