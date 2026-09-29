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

## Safe discovery and calendar creation

`CALENDAR_SYNC_AUTODISCOVERY=true` enables matching by unique Unicode-normalized
calendar name. Owner/writer Google calendars are eligible. Read-only calendars,
ambiguous duplicate names, lock/backup/technical calendars and entries in
`CALENDAR_SYNC_DENYLIST_JSON` fail closed or are excluded. The legacy
`CALENDAR_SYNC_MAP_JSON` remains an optional explicit override.

Missing calendars are only planned when
`CALENDAR_SYNC_CREATE_MISSING_CALENDARS=true`. Creating a Google calendar also
requires user OAuth (`GOOGLE_CALENDAR_AUTH_MODE=oauth`); a service account is
never treated as capable of creating a calendar owned by the user. The helper
`scripts/SETUP/google/create-google-refresh-token.js` performs the one-time
consent and writes the refresh token to an ignored, mode-0600 local file.

The synchronizer round-trips Google `transparency` and iCalendar `TRANSP`, uses
content-only fingerprints, preserves unowned ICS properties and alarms, sends
Google mutations with `sendUpdates=none`, and uses ETags/If-Match where the
providers support them. Detached recurring instances are skipped rather than
being flattened or overwriting a whole series.

## University calendar in Teams

Teams uses the Microsoft 365 Outlook/Exchange calendar. The optional bridge
syncs only the iCloud calendar named `uni 🤓` with the Microsoft primary
calendar shown by Teams. `MICROSOFT_TEAMS_CALENDAR_ID` may select another exact
calendar ID, but defaults safely to `primary`. It runs in the same process and under the
same remote lease as the Google/iCloud bridge, so it cannot create a second
writer. It is disabled unless `TEAMS_UNIVERSITY_SYNC_ENABLED=true`.

Microsoft delegated consent needs `Calendars.ReadWrite`, `User.Read` and
`offline_access`. `scripts/SETUP/microsoft/create-microsoft-refresh-token.js`
uses Device Code flow and stores the refresh token in an ignored mode-0600
file without printing it. Recurring series and deletions are deliberately not
mutated by this first Teams integration; they are surfaced as safe skips.

The GitHub Actions schedule is autonomous, does not need the PC, and runs only
ordinary Node.js code: it consumes no AI/model tokens. OAuth and Teams features
remain off until their encrypted secrets and enable flags are explicitly set.
