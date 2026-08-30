'use strict';

require('dotenv').config();
const { createRemoteLease } = require('../../../src/services/calendarSyncRemoteLease');

async function main() {
  if (!process.argv.includes('--apply')) {
    throw new Error('No se ha escrito nada. Repite con --apply para crear solo el evento tecnico de lease.');
  }
  const lease = createRemoteLease({ allowCreate: true });
  const info = await lease.acquire();
  await lease.release();
  console.log(`[calendar-lock-init] OK writer=${info.writerId}; lease tecnico creado y liberado.`);
}

main().catch(error => {
  console.error(`[calendar-lock-init] ERROR ${error.message}`);
  process.exit(1);
});
