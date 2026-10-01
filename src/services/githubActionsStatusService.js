'use strict';

async function defaultFetchRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`GitHub Actions API fallo (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fetchWorkflowRuns({ owner, repo, workflowFile, token, perPage = 10, request = defaultFetchRequest }) {
  if (!owner || !repo) throw new Error('Falta owner/repo para consultar los runs de GitHub Actions.');
  if (!workflowFile) throw new Error('Falta el nombre del workflow para consultar sus runs.');
  if (!token) throw new Error('Falta GITHUB_TOKEN para consultar GitHub Actions.');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`;
  const data = await request(url, token);
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

// Funcion pura: evalua si los runs recientes indican que el cron sigue activo
// y el ultimo resultado fue exitoso. Separada de fetchWorkflowRuns para poder
// probarla sin red.
function evaluateRunHealth(runs, { now = Date.now(), maxScheduleGapMinutes = 20 } = {}) {
  const reasons = [];
  const sorted = [...(runs || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const inProgress = sorted.some(run => run.status === 'in_progress' || run.status === 'queued');

  if (sorted.length === 0) {
    reasons.push('no hay runs registrados para este workflow');
    return { ok: false, reasons, latestConclusion: null, scheduleGapMinutes: null, inProgress };
  }

  const latest = sorted[0];
  const scheduleGapMinutes = Math.round((now - new Date(latest.created_at).getTime()) / 60_000);
  if (!Number.isFinite(scheduleGapMinutes) || scheduleGapMinutes > maxScheduleGapMinutes) {
    reasons.push(`sin ejecuciones recientes (ultima hace ${scheduleGapMinutes} min, maximo ${maxScheduleGapMinutes} min)`);
  }

  const latestConclusion = latest.status === 'completed' ? latest.conclusion : null;
  if (latest.status === 'completed' && latest.conclusion !== 'success') {
    reasons.push(`la ultima ejecucion completada termino en '${latest.conclusion}'`);
  }

  return { ok: reasons.length === 0, reasons, latestConclusion, scheduleGapMinutes, inProgress };
}

module.exports = { fetchWorkflowRuns, evaluateRunHealth, _private: { defaultFetchRequest } };
