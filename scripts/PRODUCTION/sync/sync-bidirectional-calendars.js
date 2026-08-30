'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { syncBidirectional } = require('../../../src/services/calendarBidirectionalSyncService');
const { createRemoteLease } = require('../../../src/services/calendarSyncRemoteLease');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runId = randomUUID();
let lease = null;
let shuttingDown = false;

function has(name) { return process.argv.includes(name); }

function redact(value) {
  let text = String(value);
  const sensitiveNames = [
    'ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD', 'CALENDAR_SYNC_MAP_JSON',
    'CALENDAR_SYNC_LOCK_CALENDAR_ID', 'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
  ];
  for (const name of sensitiveNames) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) text = text.split(secret).join('<redacted>');
  }
  return text;
}

function log(level, message, fields = {}) {
  const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const line = redact(`[${new Date().toISOString()}] ${level} ${message}${suffix}`);
  (level === 'ERROR' ? console.error : console.log)(line);
}

function heartbeatPath() {
  return path.resolve(process.env.CALENDAR_SYNC_HEARTBEAT_PATH || path.join(ROOT, 'logs', 'calendar-sync-heartbeat.json'));
}

function writeHeartbeat(status, fields = {}) {
  const target = heartbeatPath();
  const temp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify({
    version: 1, timestamp: new Date().toISOString(), status, runId,
    writerId: process.env.CALENDAR_SYNC_WRITER_ID || null, ...fields,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function systemdNotify(argument) {
  if (process.platform !== 'linux' || !process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', [argument], { timeout: 5_000 }, error => {
    if (error) log('WARN', 'No se pudo notificar a systemd.', { reason: error.message });
  });
}

function print(result, { compact = false } = {}) {
  log('INFO', 'Sincronizacion completada.', {
    mode: result.dryRun ? 'dry-run' : 'apply', conflictPolicy: result.conflictPolicy,
    propagateDeletes: result.propagateDeletes, calendars: result.calendars.length,
    window: result.window, counts: result.counts,
  });
  const visible = compact ? result.operations.filter(op => op.type !== 'skip_unchanged') : result.operations;
  for (const operation of visible.slice(0, 40)) {
    const fields = { type: operation.type };
    if (process.env.CALENDAR_SYNC_LOG_EVENT_DETAILS === 'true') fields.calendar = operation.calendar;
    log('INFO', 'Operacion.', fields);
  }
  if (visible.length > 40) log('INFO', 'Operaciones adicionales omitidas del log.', { count: visible.length - 40 });
}

function watchIntervalMs() {
  const seconds = Number.parseInt(process.env.CALENDAR_SYNC_WATCH_INTERVAL_SECONDS || '15', 10);
  return (Number.isFinite(seconds) && seconds >= 5 ? seconds : 15) * 1000;
}

function parseMode() {
  const once = has('--once');
  const watch = has('--watch');
  if (once && watch) throw new Error('Usa --once o --watch, no ambos.');
  return watch ? 'watch' : 'once';
}

async function verifyBotCalendars() {
  const GoogleCalendarProvider = require('../../../src/providers/GoogleCalendarProvider');
  const provider = new GoogleCalendarProvider();
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const events = await provider._fetchBusyEvents(start, end);
  const expected = Object.keys(JSON.parse(process.env.CALENDAR_SYNC_MAP_JSON || '{}')).length;
  if (provider.calendarIds.length !== expected) {
    throw new Error(`El bot esperaba ${expected} calendarios y encontro ${provider.calendarIds.length}.`);
  }
  log('INFO', 'Comprobacion del bot completada.', { calendars: provider.calendarIds.length, busyEvents: events.length });
}

async function syncOnce({ dryRun, compact, mode }) {
  writeHeartbeat('running', { mode, dryRun });
  const startedAt = Date.now();
  const result = await syncBidirectional({ dryRun });
  print(result, { compact });
  writeHeartbeat('ok', { mode, dryRun, durationMs: Date.now() - startedAt, counts: result.counts });
  systemdNotify('WATCHDOG=1');
  return result;
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', 'Cierre solicitado.', { signal });
  if (lease) await lease.release();
  process.exit(exitCode);
}

async function main() {
  const apply = has('--apply');
  const explicitDry = has('--dry-run');
  if (apply && explicitDry) throw new Error('Usa --apply o --dry-run, no ambos.');
  const dryRun = !apply;
  const mode = parseMode();

  if (apply && (has('--require-remote-lock') || process.env.CALENDAR_SYNC_REQUIRE_REMOTE_LOCK === 'true')) {
    lease = createRemoteLease();
    const lock = await lease.acquire();
    log('INFO', 'Lease remoto adquirido.', { writerId: lock.writerId, ttlSeconds: lock.ttlSeconds });
  } else if (apply && process.env.CALENDAR_SYNC_ALLOW_UNSAFE_NO_LOCK !== 'true') {
    throw new Error('APPLY exige --require-remote-lock. El modo sin lock solo se admite temporalmente en el Windows legado.');
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  log('INFO', 'Inicio del sincronizador bidireccional.', { mode, dryRun, runId });
  await syncOnce({ dryRun, compact: mode === 'watch', mode });
  if (has('--verify-bot')) await verifyBotCalendars();
  if (mode === 'once') {
    if (lease) await lease.release();
    lease = null;
    return;
  }

  systemdNotify('READY=1');
  const intervalMs = watchIntervalMs();
  log('INFO', 'Vigilancia continua activa.', { intervalSeconds: intervalMs / 1000 });
  while (true) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      await syncOnce({ dryRun, compact: true, mode });
    } catch (error) {
      writeHeartbeat('error', { mode, dryRun, error: redact(error.message) });
      log('ERROR', 'Fallo de sincronizacion en modo watch.', { error: error.message });
    }
  }
}

main().catch(async error => {
  try { writeHeartbeat('error', { error: redact(error.message) }); } catch (_) {}
  log('ERROR', 'Sincronizador finalizado con error.', { error: error.message });
  if (lease) await lease.release();
  process.exit(1);
});
