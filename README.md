# Calendar Sync Free Cloud

Minimal bidirectional bridge between iCloud CalDAV and Google Calendar. It runs
as a one-shot GitHub Actions job on a standard public-repository runner, which
has no recurring compute charge.

Safety properties:

- strict iCloud-name and Google-ID allowlists;
- remote lease prevents two writers;
- Google cancellations can propagate to linked iCloud events with
  `CALENDAR_SYNC_GOOGLE_DELETES_TO_ICLOUD=true` (enabled in production);
- every propagated deletion first saves and reads back a lossless compressed
  backup in the existing technical Google calendar, then uses iCloud's ETag;
- unlinked cancellations, individual recurring instances and ambiguous matches
  never delete an entire iCloud event; missing events alone are not deletions;
- secrets exist only as GitHub Actions encrypted secrets;
- logs omit event names, IDs and credentials;
- no artifacts, caches, packages or paid runners.

Production mappings and allowlists are supplied through Actions secrets.
The cloud schedule requests a run every five minutes; a local fallback uses
the same remote lease. GitHub scheduling is best effort.

Deletion backups are private, transparent technical events dated 2000-01-01.
Their `extendedProperties.private` contains `deletionBackup=v1`, a SHA-256
checksum, a chunk count and `data0..N` chunks. Concatenate the chunks, base64
decode and gunzip to recover JSON containing the original ICS, URL and ETag.
Restoration must use create-only semantics to avoid overwriting a newer event.
Backups remain in the technical calendar, never in public logs or artifacts.

## Monitoring and alerts

- `calendar-sync.yml` emails on `failure()` of its own job — a broken `npm
  test`, a sync error, or a stale/error heartbeat caught by
  `calendar-sync-healthcheck.js`. This only fires while the job itself runs.
- `calendar-sync-remote-health.yml` runs hourly, independent of any single
  sync job, and checks three things that a per-run heartbeat can never see:
  whether GitHub actually fired `calendar-sync.yml` recently (catches
  silent scheduling throttling on low-activity repos), whether the remote
  lease looks claimed with no run in progress (a hard-killed job can leave
  it dangling — this is a heuristic early warning, not a fix: the lease
  self-heals once its TTL, default 600s, lapses regardless), and whether
  iCloud CalDAV is reachable and authenticated (read-only probe, never
  touches real calendar data). Run it on demand with
  `npm run health:remote`, or trigger the GitHub Actions
  `workflow_dispatch` with `simulate_failure: true` to fire a test alert
  without exercising any real check.
- Both alerts need three new repo secrets: `CALENDAR_SYNC_ALERT_SMTP_USER`
  (the Gmail address used as SMTP login/From), `CALENDAR_SYNC_ALERT_SMTP_PASSWORD`
  (a Gmail App Password, not the account password), and
  `CALENDAR_SYNC_ALERT_EMAIL_TO` (the recipient).
