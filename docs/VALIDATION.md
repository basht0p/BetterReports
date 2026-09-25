# Validation

## Automated local checks

`npm test` covers date math, timezone validation, DST gaps/repeats, missed-run coalescing, supported/unsupported sources, inherited searches, owner/tenant isolation, revision snapshots, competing workers, email ambiguity, retry date stability, cancellation fencing, revoked access, 100-schedule queue admission, rendering concurrency, Letter dimensions, embedded fonts, absence of screenshot images, chart values, and PDF limits.

`npm run typecheck` checks the application and domain code. Platform entrypoints use a deliberately isolated runtime adapter, so this command is not a substitute for the 3.8.0 deployment test.

`npm run check:platform` checks the exact source signatures and asset-loader conventions used by the adapter and packager. It is a source-contract check, not a full monorepo typecheck.

`npm run demo` generates a multi-page synthetic report for visual inspection. Render every page to an image and review headers, footers, table repetition, fonts, charts, margins, and overflow. Production acceptance also requires representative real dashboard fixtures.

## Isolated 3.8.0 environment

The Docker files under `dev/` and scripts `dev-up.mjs` and `integration.mjs` provide a loopback-only local fixture deployment. They create test identities, data, and saved objects on that disposable cluster. They must never be pointed at a production cluster. See the scripts for the fixed local ports and resource names.

```sh
npm run build
npm run build:companion
node scripts/dev-up.mjs
npm run test:integration
npm run test:companion -- --restart
npm run test:saml
# Two-instance and workload checks:
node scripts/dev-up.mjs --multi
node scripts/integration.mjs --multi
node scripts/fls-test.mjs
node scripts/load-test.mjs
node scripts/notifications-integration.mjs
```

## Release acceptance

Release 0.0.2 was exercised in the official 3.8.0 images with Security, Notifications, and the normal Reporting plugin installed. Its 28 unit tests and type/source-contract checks passed. Live checks covered supported visualization/aggregation types, tenant/owner isolation, revoked access, source refresh versus fresh data, Notifications PDF attachments, current group membership, disabled-sender rejection, temporary-channel cleanup, and delivery after a signed SAML session expired. Two Dashboards instances completed and delivered 100 scheduled PDFs with 100 distinct emails and peak concurrency of two per instance (about 285 seconds overall; scheduled-to-completion p95 about 225 seconds in the disposable fixture). Machine-readable results are generated under `output/integration/`.

Browser checks cover the secondary sidebar, relative date editor, searchable timezone choices, keyboard section reordering, Reports navigation from the editor, Cancel, and in-page delete confirmation without a JavaScript dialog. The Notifications fixture uses a local mail sink and does not contact real recipients. Verify your deployment's sender credentials and TLS using Notifications before enabling production schedules.

Before production rollout, also verify these scenarios with representative deployment data:

- Install/uninstall the ZIP on exact 3.8.0; open all BetterReports screens and its dashboard Share action.
- Import all supported visualization types; compare numbers against the same saved dashboard with the same absolute time interval and filters.
- Include date histograms across DST, multiple series, percentile metrics, table sorting, empty data, field formatters, inherited queries, and panel overrides.
- Edit a source: existing reports retain the old configuration until explicit refresh, but their data updates on every run.
- Confirm current DLS/FLS restrictions, missing sources, revoked tenant permissions, and blocked direct access to internal indices.
- Confirm indefinite grants survive SAML session expiry and node restarts; changing captured role definitions affects execution, while removing IdP membership requires explicit grant revocation. Verify tenant-manager revocation and that the worker cannot issue direct business-data searches.
- Confirm same-tenant users can read shared definitions, tenant writers can edit/clone, and read-only tenant members cannot modify definitions. Verify different tenants cannot access definitions by guessed URLs. Verify Global-admin metadata inventory and private-tenant isolation. Status, recipient lists, and artifacts remain private to their generating user.
- Close the browser and observe scheduled PDF email. Test two Dashboards instances against the same queue, process termination during rendering and sending, SMTP rejection, uncertain relay acceptance, retries, and retention cleanup.
- Render 20-page reports with two simultaneous jobs; record memory, duration, UI responsiveness, and queue delay. Fail a 21-page report explicitly. The 100-schedule unit scenario is not a complete production load benchmark.
- Verify every page is US Letter, native text can be extracted, charts have vector paths, tables have repeated headers, and branding never overlaps content. Check that preview download matches the stored PDF checksum.

Keep the generated test results and sample PDFs with the release evidence. Do not treat a successful build as proof that all release acceptance scenarios passed.

Release 0.0.3 passed the same 28 unit tests, TypeScript checks, and 15 exact-platform source contracts. Browser validation on the official 3.8.0 Dashboards image covered aligned sidebar/schedule controls, source import into the native filter builder, adding two filters, reopening saved filters, editing a range, custom labels, and saving query changes without a separate query submission. A PDF generated from the UI's saved phrase and range filters matched a direct authorized aggregation (including Discover's exclusive range upper bound); all pages measured 612 x 792 points. Filter edits remain local to the report rather than updating the global filter manager. The 0.0.2 load test was not repeated for this UI-only change.

Release 0.0.4 validates Gauge, Goal, Heat Map, Horizontal Bar, Coordinate Map, Region Map, and Tag Cloud through actual authorized aggregation queries and Letter PDF output in the disposable 3.8.0 integration suite. Timeline and the separate Maps application are excluded from this release.

## 0.1.0 regression coverage

The renderer fixtures exercise long email-address legends at full and two-column widths, explicit wrapping and pagination, hidden legends, and color-scale visibility. Unit tests check native field hydration from current mappings without source-snapshot mutation, including a keyword multifield omitted from the saved snapshot.

The live suite checks shared report access and cloning within a tenant, read-only tenant permissions, Global-admin inventory, private-tenant isolation, separate per-user runs and PDFs, and retirement of an old authorization after a teammate edits a report. Browser validation should cover the native field/operator/custom-label controls, multiple saved filters, branding tiles, cloning, and persistence of the Hide legend checkbox. Generated renderer fixtures are kept under `target/`; live integration and browser evidence are kept under `output/`.

## 0.1.2 regression coverage

The 46-test unit suite covers tenant-derived and private-tenant organization scope, rejected scope widening, explicit Global selection and save acknowledgment, stale stored reports, grant fingerprints, and permission checks independent of configured inventory roles. TypeScript checking, all 24 exact-platform source contracts, and both plugin package builds pass against OpenSearch/OpenSearch Dashboards 3.8.0.

The disposable integration suites include real aggregation/PDF comparisons for exact, prefixed, case-variant, and missing organization names; Global selection and unrestricted acknowledgment; exact administrator-action authorization; and direct companion rejection of scope tampering, scope-escaping aggregations, and normalized keyword mappings. Browser acceptance should cover the scope selector, acknowledgment reset and clone flow, and left-aligned checkboxes. Interactive browser validation could not be completed in this session because the browser connection failed; UI behavior and CSS received source review.

The 0.1.2 live companion suite passed against the disposable 3.8.0 cluster, including scoped queries with DLS/FLS, required mapping permission, keyword multifields, unsafe mapping and aggregation rejection, grant durability, and revocation. A restart-survival run and the 100-schedule load test were not repeated for this release.
