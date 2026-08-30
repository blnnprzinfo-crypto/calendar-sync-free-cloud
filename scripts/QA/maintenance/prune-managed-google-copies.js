'use strict';

require('dotenv').config();

const { syncBidirectional, getCalendarMap } = require('../../../src/services/calendarBidirectionalSyncService');
const { createRemoteLease } = require('../../../src/services/calendarSyncRemoteLease');

async function main() {
  const apply = process.argv.includes('--apply');
  const configuredMap = JSON.parse(process.env.CALENDAR_SYNC_MAP_JSON || '{}');
  process.env.CALENDAR_SYNC_ALLOWED_ICLOUD_NAMES_JSON ||= JSON.stringify(Object.keys(configuredMap));
  process.env.CALENDAR_SYNC_ALLOWED_GOOGLE_IDS_JSON ||= JSON.stringify(Object.values(configuredMap));
  const mappings = getCalendarMap();
  if (process.env.CALENDAR_SYNC_ENFORCE_ALLOWLIST !== 'true') {
    throw new Error('La limpieza exige CALENDAR_SYNC_ENFORCE_ALLOWLIST=true.');
  }
  if (process.env.CALENDAR_SYNC_PRUNE_MANAGED_GOOGLE_ORPHANS !== 'true') {
    throw new Error('La limpieza exige CALENDAR_SYNC_PRUNE_MANAGED_GOOGLE_ORPHANS=true.');
  }

  let lease = null;
  try {
    if (apply) {
      lease = createRemoteLease();
      await lease.acquire();
    }
    const result = await syncBidirectional({ dryRun: !apply, pruneManagedGoogleOrphans: true });
    const cleanup = result.operations.filter(operation => operation.type.startsWith('delete_google_'));
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      calendars: mappings.length,
      counts: result.counts,
      cleanupCount: cleanup.length,
    }));
  } finally {
    if (lease) await lease.release();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
