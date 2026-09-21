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
```

## Release acceptance

The implementation has been exercised in the official 3.8.0 images with Security and the normal Reporting plugin installed: all supported visualization/aggregation types, DLS/FLS, tenant and owner isolation, revoked access, source refresh versus fresh data, actual PDF.js preview, SMTP STARTTLS, two-instance execution, and 100 scheduled PDFs. Machine-readable results are generated under `output/integration/`. Unit tests cover DST transitions, leases, cancellation, retry dates, ambiguous SMTP, and graceful shutdown recovery.

Before production rollout, also verify these scenarios with representative deployment data:

- Install/uninstall the ZIP on exact 3.8.0; open all BetterReports screens and its dashboard Share action.
- Import all supported visualization types; compare numbers against the same saved dashboard with the same absolute time interval and filters.
- Include date histograms across DST, multiple series, percentile metrics, table sorting, empty data, field formatters, inherited queries, and panel overrides.
- Edit a source: existing reports retain the old configuration until explicit refresh, but their data updates on every run.
- Confirm current DLS/FLS restrictions, missing sources, revoked tenant permissions, and blocked direct access to internal indices.
- Confirm indefinite grants survive SAML session expiry and node restarts; changing captured role definitions affects execution, while removing IdP membership requires explicit grant revocation. Verify tenant-manager revocation and that the worker cannot issue direct business-data searches.
- Confirm a second user and a different tenant cannot read another owner's definitions, status, recipient lists, or artifacts, including guessed URLs.
- Close the browser and observe scheduled PDF email. Test two Dashboards instances against the same queue, process termination during rendering and sending, SMTP rejection, uncertain relay acceptance, retries, and retention cleanup.
- Render 20-page reports with two simultaneous jobs; record memory, duration, UI responsiveness, and queue delay. Fail a 21-page report explicitly. The 100-schedule unit scenario is not a complete production load benchmark.
- Verify every page is US Letter, native text can be extracted, charts have vector paths, tables have repeated headers, and branding never overlaps content. Check that preview download matches the stored PDF checksum.

Keep the generated test results and sample PDFs with the release evidence. Do not treat a successful build as proof that all release acceptance scenarios passed.
