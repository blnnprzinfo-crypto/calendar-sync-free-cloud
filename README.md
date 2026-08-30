# Calendar Sync Free Cloud

Minimal bidirectional bridge between iCloud CalDAV and Google Calendar. It runs
as a one-shot GitHub Actions job on a standard public-repository runner, which
has no recurring compute charge.

Safety properties:

- strict iCloud-name and Google-ID allowlists;
- remote lease prevents two writers;
- deletion propagation is rejected in code;
- secrets exist only as GitHub Actions encrypted secrets;
- logs omit event names, IDs and credentials;
- no artifacts, caches, packages or paid runners.

The checked-in workflow is intentionally locked to the disposable calendar
`SYNC-TEST-iCloud` and expects exactly one mapping. Production calendars require
a separate reviewed cutover.
