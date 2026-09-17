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
checksum, a chunk count, `data0..N` chunks, and readable `originalSummary`/
`originalStart`/`deletedAt` fields for listing without decompressing.
Backups remain in the technical calendar, never in public logs or artifacts.

To recover an appointment that was deleted in Google (and therefore removed
from iCloud), use the restore tool instead of decoding backups by hand:

```
npm run restore:list                                           # see what's recoverable
node scripts/PRODUCTION/sync/restore-deleted-icloud-event.js --id <backup-id>            # preview
node scripts/PRODUCTION/sync/restore-deleted-icloud-event.js --id <backup-id> --apply    # restore
```

Restoration always uses create-only semantics (`If-None-Match: *`) so it can
never overwrite a newer event that already exists at the same iCloud href —
if one exists, the restore fails loudly instead of silently discarding it.
