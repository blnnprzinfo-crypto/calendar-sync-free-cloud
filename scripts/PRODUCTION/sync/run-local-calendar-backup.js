'use strict';

// Local fallback for delayed cloud schedules. Uses the same remote lease.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'logs/local-backup-config.json'), 'utf8'));
const source = require('dotenv').parse(fs.readFileSync(config.envPath));
for (const [name, value] of Object.entries(source)) {
  if (/^(ICLOUD_|GOOGLE_CALENDAR_|GOOGLE_SERVICE_ACCOUNT_|GOOGLE_PRIVATE_KEY$|CALENDAR_SYNC_MAP_JSON$)/.test(name)) {
    process.env[name] = value;
  }
}
Object.assign(process.env, {
  TZ: 'Europe/Madrid',
  ICLOUD_SYNC_PAST_DAYS: '30',
  ICLOUD_SYNC_FUTURE_DAYS: '365',
  CALENDAR_SYNC_PROPAGATE_DELETES: 'false',
  CALENDAR_SYNC_GOOGLE_DELETES_TO_ICLOUD: 'true',
  CALENDAR_SYNC_PRUNE_MANAGED_GOOGLE_ORPHANS: 'false',
  CALENDAR_SYNC_CONFLICT_POLICY: 'newest_wins',
  CALENDAR_SYNC_REQUIRE_REMOTE_LOCK: 'true',
  CALENDAR_SYNC_LOCK_ALLOW_CREATE: 'false',
  CALENDAR_SYNC_LOCK_CALENDAR_ID: config.lockCalendarId,
  CALENDAR_SYNC_WRITER_ID: 'windows-calendar-backup',
  CALENDAR_SYNC_LOG_EVENT_DETAILS: 'false',
  CALENDAR_SYNC_ENFORCE_ALLOWLIST: 'true',
  CALENDAR_SYNC_EXPECTED_MAPPING_COUNT: String(config.icloudNames.length),
  CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON: JSON.stringify(config.icloudNames),
  CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON: JSON.stringify(config.googleIds),
  CALENDAR_SYNC_HEARTBEAT_PATH: path.join(root, 'logs/local-backup-heartbeat.json'),
});
if (!process.argv.includes('--dry-run')) process.argv.push('--apply');
process.argv.push('--once', '--require-remote-lock');
require('./sync-bidirectional-calendars');
