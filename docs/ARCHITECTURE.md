# Architecture

`public/` contains the React/EUI application and embedded PDF.js viewer. `common/` contains validation schemas and shared record types. `server/platform.ts` isolates the exact OpenSearch Dashboards 3.8.0 integration. Server modules implement source import, records, scheduling, Notifications delivery, and the ECharts/pdfmake renderer.

## Execution

1. Import and validate saved source configurations under the authenticated owner and tenant.
2. Save a report snapshot and explicitly authorize a durable companion grant; leave original sources unchanged.
3. Enqueue a run with a frozen report revision and absolute reporting interval.
4. Atomically claim the run with a sequence-number comparison and fencing token.
5. Validate the grant and revision, execute its approved queries inside OpenSearch with the captured role membership, and normalize returned results using frozen field settings.
6. Render in a bounded Node worker thread so PDF composition cannot block Dashboards' event loop. The worker receives data only, not credentials.
7. Persist the PDF with a checksum and expiration, then publish the artifact reference using the current fence.
8. For email, recheck grant revocation and persist `sending` before contacting Notifications. Record completion, definitive failure, or uncertain delivery.

All execution results and scheduling metadata are stored in `.better-reports-v1-{reports,schedules,runs,artifacts}`. Index mappings intentionally exclude report bodies and PDF data from indexing. OpenSearch sequence numbers and primary terms guard updates. The dedicated internal storage identity is separate from the restricted worker identity.

The native filter picker fetches current, authorized index-pattern field metadata without changing the saved report snapshots. Report queries continue to use the saved source configuration until explicit refresh.

The source adapter uses 3.8.0 `search.searchSource.asScoped`, `search.aggs.asScopedToClient`, `indexPatternsServiceFactory`, and `tabifyAggResponse`. Field definitions and field format mappings are taken from the imported snapshot. Interactive source reads verify current access. Scheduled queries use the authorized snapshots and do not require a new SAML session. Grants are stored separately in the protected `.better-reports-grants-v1` system index and have no expiration.

## API

All routes start with `/api/better_reports` and require authentication. Report definitions use tenant scope; writes require current tenant write permission. Private-tenant definitions also retain an owner check. PDFs, run history, and schedules keep owner-and-tenant checks. Global-tenant administrators can list all-tenant report metadata, but must switch tenants before report actions. JSON bodies use schemas from `common/model.ts`.

| Method | Route | Behavior |
|---|---|---|
| GET | `/sources?search=&page=1` | Discover accessible dashboard/visualization sources |
| POST | `/sources/import` | Import `{type,id}`; return supported snapshots and per-panel errors |
| GET | `/context` | Current tenant capabilities and all-tenant inventory status |
| GET, POST | `/reports` | List branded tenant summaries or create a report |
| POST | `/reports/{id}/clone` | Copy a definition using `{revision}` without grants, schedules, or artifacts |
| GET, PUT, DELETE | `/reports/{id}` | Read, replace using `{revision,report}`, or delete |
| POST | `/reports/{id}/refresh` | Refresh saved source snapshots using `{revision}` |
| POST | `/preview` | Queue an unsaved report body and return `{runId}` |
| POST | `/reports/{id}/runs` | Queue a saved report and return `{runId}` |
| GET | `/runs`, `/runs/{id}` | Owned history and status |
| POST | `/runs/{id}/cancel` | Cancel a queued/generating run |
| GET | `/runs/{id}/pdf` | Authorized PDF stream; `?encoding=base64` returns JSON for the platform HTTP client |
| GET, POST | `/schedules` | List or create schedules |
| PUT, DELETE | `/schedules/{id}` | Replace using `{revision,schedule}` or delete |
| POST | `/schedules/next` | Preview five times using `{cron,timezone}` |
| POST | `/schedules/{id}/run` | Deliberately send a report to the configured recipients now |
| GET | `/health` | Administrator-only instance health and limits |
| GET | `/admin/schedules` | Administrator-only schedule ownership/status metadata |
| POST | `/admin/schedules/{id}/pause` | Administrator-only pause |

Errors return HTTP status, a human-readable `message`, and `attributes.code`. Conflicting edits return 409; inaccessible IDs return 404. Artifact expiration returns 410. Initialization failure returns 503. Request bodies are capped at 5 MiB.

## Recovery and retention

Lease heartbeat: 15 seconds; lease duration: 60 seconds. Expired generating runs can be reclaimed with a new fence. Expired sending runs become `delivery_unknown`, preventing automatic duplicate email. Retryable failures have up to three total attempts, with 30/60-second delays. An occurrence keeps its original dates across retries.

Cleanup runs hourly; PDFs expire after seven days and run records after 30 days by default. Deleting a definition pauses its schedules, while existing run snapshots retain their normal expiration. Do not delete cluster indices during plugin uninstall; export or snapshot them before any intentional removal.

## Changes and migrations

The initial schema uses version 1 indices and report `schemaVersion: 1`. Future mapping changes require a new index version and an explicit migration; never reinterpret older report definitions silently. Platform upgrades require rebuilding and testing a matching plugin artifact. Runtime dependencies and versions are locked in package-lock.json.

## Companion grant API

All companion routes use POST under `/_plugins/_better_reports/` and have individual `cluster:admin/betterreports/<operation>` transport permissions. `authorize` accepts compiled aggregation queries and captures identity from Security's authenticated thread context; it does not accept owner or role parameters. `execute` accepts a grant ID, revision fingerprint and absolute reporting interval. `check` validates revocation/fingerprint. `list` and `revoke` enforce owner or named tenant-manager role plus current tenant access. No general query proxy or impersonation endpoint is exposed.

The worker-only `invalidate` action retires a persistent grant by exact ID and fingerprint after an authorized shared-report mutation. It does not accept replacement identities or queries. Changing, refreshing, deleting, or reauthorizing a shared report retires its previous grant and pauses linked schedules. The grant records its authorizer separately from the report creator; scheduled execution and its private run history belong to that authorizer. Manual runs create temporary permissions for the current caller. Clones never carry over grants.

Dashboards routes add `POST /reports/{id}/authorize` with `{revision}`, `GET /grants`, and `POST /grants/{id}/revoke`. A saved report's authorization is invalidated on edits and refresh. Legacy reports require authorization before scheduled execution. The grant lifetime is explicitly indefinite; IdP membership changes are not automatic grant revocation. Current definitions of captured OpenSearch roles continue to govern data access.

`authorize` also accepts a display title and a `persistent` boolean. Explicit scheduling uses persistent grants. One-off previews/manual runs use temporary permissions; the worker-only `release` action removes only these permissions after a terminal run state. Retried runs keep their temporary permission, and a periodic cleanup recovers releases interrupted by a restart. Released permissions do not affect access to already generated PDFs, which retains interactive owner/tenant/source checks.
