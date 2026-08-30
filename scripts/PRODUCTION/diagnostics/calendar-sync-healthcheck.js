'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const target = path.resolve(process.env.CALENDAR_SYNC_HEARTBEAT_PATH || path.join(ROOT, 'logs', 'calendar-sync-heartbeat.json'));
const maxAgeSeconds = Number.parseInt(process.env.CALENDAR_SYNC_HEARTBEAT_MAX_AGE_SECONDS || '180', 10);

try {
  const heartbeat = JSON.parse(fs.readFileSync(target, 'utf8'));
  const ageSeconds = Math.round((Date.now() - Date.parse(heartbeat.timestamp)) / 1000);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    throw new Error(`heartbeat obsoleto: ${ageSeconds}s (maximo ${maxAgeSeconds}s)`);
  }
  if (heartbeat.status === 'error') throw new Error('el ultimo estado es error');
  console.log(`[calendar-health] OK age=${ageSeconds}s status=${heartbeat.status} mode=${heartbeat.mode || 'unknown'}`);
} catch (error) {
  console.error(`[calendar-health] FAIL ${error.message}`);
  process.exit(1);
}
