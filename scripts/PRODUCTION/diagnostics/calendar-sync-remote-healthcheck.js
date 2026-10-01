'use strict';

require('dotenv').config();

const googleAuth = require('../../../src/services/googleCalendarAuthService');
const icloud = require('../../../src/services/icloudCalDavService');
const { fetchWorkflowRuns, evaluateRunHealth } = require('../../../src/services/githubActionsStatusService');
const { readLeaseState } = require('../../../src/services/calendarSyncRemoteLease');

function parseOwnerRepo() {
  const full = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new Error('Falta GITHUB_REPOSITORY (owner/repo).');
  return { owner, repo };
}

// Orquesta los tres chequeos independientes y agrega el resultado. Cada uno
// se captura por separado para que un fallo no oculte a los otros.
async function evaluateRemoteHealth({
  fetchWorkflowRuns: fwr = fetchWorkflowRuns,
  readLeaseState: rls = readLeaseState,
  pingIcloud: pi = icloud.pingIcloud,
  now = Date.now(),
  simulateFailure = false,
} = {}) {
  if (simulateFailure) return { ok: false, failures: ['fallo simulado (workflow_dispatch simulate_failure=true)'] };

  const failures = [];

  try {
    const { owner, repo } = parseOwnerRepo();
    const workflowFile = process.env.CALENDAR_SYNC_WORKFLOW_FILE || 'calendar-sync.yml';
    const maxScheduleGapMinutes = Number.parseInt(process.env.CALENDAR_SYNC_REMOTE_HEALTH_MAX_SCHEDULE_GAP_MINUTES || '20', 10);
    const token = process.env.GITHUB_TOKEN;
    const runs = await fwr({ owner, repo, workflowFile, token });
    const health = evaluateRunHealth(runs, { now, maxScheduleGapMinutes });
    if (!health.ok) failures.push(...health.reasons.map(reason => `github: ${reason}`));

    if (health.inProgress === false) {
      const lease = await rls({ getAccessToken: googleAuth.getAccessToken });
      if (lease.isClaimed) failures.push(`lease reclamado por '${lease.owner}' hasta ${lease.expiresAt} sin ningun run de GitHub en curso`);
    }
  } catch (error) {
    failures.push(`github/lease: ${error.message}`);
  }

  try {
    await pi();
  } catch (error) {
    failures.push(`icloud: ${error.message}`);
  }

  return { ok: failures.length === 0, failures };
}

async function main() {
  const simulateFailure = process.env.CALENDAR_SYNC_SIMULATE_FAILURE === 'true';
  const result = await evaluateRemoteHealth({ simulateFailure });
  if (!result.ok) {
    console.error(`[calendar-remote-health] FAIL ${result.failures.join('; ')}`);
    process.exit(1);
  }
  console.log('[calendar-remote-health] OK');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[calendar-remote-health] FAIL ${error.message}`);
    process.exit(1);
  });
}

module.exports = { evaluateRemoteHealth };
