'use strict';

const { randomUUID } = require('node:crypto');
const googleAuth = require('./googleCalendarAuthService');

const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3';
const LOCK_EVENT_ID = 'ca1e0da2f5e10c0c';

function positiveInt(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

async function request(method, path, token, body, headers = {}) {
  const response = await fetch(`${GOOGLE_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Google Calendar lease ${method} fallo (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function props(event) {
  return event?.extendedProperties?.private || {};
}

function lockBody(owner, expiresAt, existing = {}) {
  return {
    id: LOCK_EVENT_ID,
    summary: '[tecnico] Lease del sincronizador de calendarios',
    description: 'Evento tecnico transparente. Impide que dos sincronizadores escriban a la vez.',
    start: { date: '2000-01-01' },
    end: { date: '2000-01-02' },
    transparency: 'transparent',
    visibility: 'private',
    extendedProperties: { private: {
      ...props(existing),
      belenciagaCalendarSyncLock: 'v1',
      belenciagaCalendarSyncOwner: owner,
      belenciagaCalendarSyncExpiresAt: expiresAt,
    } },
  };
}

function createRemoteLease(options = {}) {
  const calendarId = String(options.calendarId || process.env.CALENDAR_SYNC_LOCK_CALENDAR_ID || '').trim();
  const writerId = String(options.writerId || process.env.CALENDAR_SYNC_WRITER_ID || '').trim();
  if (!calendarId) throw new Error('Falta CALENDAR_SYNC_LOCK_CALENDAR_ID para la exclusion remota.');
  if (!writerId) throw new Error('Falta CALENDAR_SYNC_WRITER_ID para identificar este escritor.');

  const ttlSeconds = positiveInt(process.env.CALENDAR_SYNC_LOCK_TTL_SECONDS, 600, 120);
  const allowCreate = options.allowCreate ?? process.env.CALENDAR_SYNC_LOCK_ALLOW_CREATE === 'true';
  const owner = `${writerId}:${randomUUID()}`;
  const httpRequest = options.request || request;
  const getAccessToken = options.getAccessToken || googleAuth.getAccessToken;
  let token;
  let current;
  let renewalTimer;
  let stopped = false;

  const eventPath = `/calendars/${encodeURIComponent(calendarId)}/events/${LOCK_EVENT_ID}`;

  async function load() {
    try {
      return await httpRequest('GET', eventPath, token);
    } catch (error) {
      if (error.status === 404 || error.status === 410) return null;
      throw error;
    }
  }

  async function claim(attempt = 1) {
    if (attempt > 5) throw new Error('No se pudo adquirir el lease tras 5 intentos concurrentes.');
    const now = Date.now();
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
    const existing = await load();
    if (!existing) {
      if (!allowCreate) {
        throw new Error('El evento de lease no existe. Inicializalo una sola vez antes de arrancar escritores.');
      }
      try {
        current = await httpRequest(
          'POST',
          `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
          token,
          lockBody(owner, expiresAt)
        );
        return;
      } catch (error) {
        if (error.status !== 409) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
        return claim(attempt + 1);
      }
    }

    const existingOwner = props(existing).belenciagaCalendarSyncOwner || 'desconocido';
    const existingExpiry = Date.parse(props(existing).belenciagaCalendarSyncExpiresAt || '') || 0;
    if (existingOwner !== owner && existingExpiry > now) {
      throw new Error(`Lease ocupado por otro escritor hasta ${new Date(existingExpiry).toISOString()}.`);
    }

    try {
      current = await httpRequest('PATCH', `${eventPath}?sendUpdates=none`, token, lockBody(owner, expiresAt, existing), {
        'If-Match': existing.etag,
      });
    } catch (error) {
      if (error.status === 412) {
        await new Promise(resolve => setTimeout(resolve, 250));
        return claim(attempt + 1);
      }
      throw error;
    }
  }

  async function acquire() {
    token = await getAccessToken();
    await claim();
    const renewEveryMs = Math.floor(ttlSeconds * 1000 / 3);
    renewalTimer = setInterval(() => {
      claim().catch(error => {
        console.error(`[calendar-lock] ${new Date().toISOString()} lease perdido: ${error.message}`);
        process.exit(1);
      });
    }, renewEveryMs);
    renewalTimer.unref();
    return { writerId, ttlSeconds };
  }

  async function release() {
    if (stopped) return;
    stopped = true;
    if (renewalTimer) clearInterval(renewalTimer);
    const existing = await load().catch(() => null);
    if (!existing || props(existing).belenciagaCalendarSyncOwner !== owner) return;
    const expired = new Date(0).toISOString();
    await httpRequest('PATCH', `${eventPath}?sendUpdates=none`, token, lockBody(owner, expired, existing), {
      'If-Match': existing.etag,
    }).catch(() => {});
  }

  return { acquire, release };
}

module.exports = { createRemoteLease, _private: { LOCK_EVENT_ID, lockBody, props } };
