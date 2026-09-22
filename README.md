# BetterReports

Rendered, branded US Letter PDF reports for **OpenSearch and OpenSearch Dashboards 3.8.0**.

**Latest release: [v0.0.4](https://github.com/basht0p/BetterReports/releases/tag/v0.0.4).** Download both plugin ZIPs and their SHA-256 checksums from the release. The plugin version is `0.0.4`; `3.8.0` in the archive filenames identifies the required OpenSearch platform version.

BetterReports imports saved dashboards and visualizations into reusable sections, runs approved queries through durable, revocable OpenSearch grants, and produces vector charts and selectable PDF text. The same PDF is used for preview, download, and Notifications email attachments. Scheduled jobs run inside Dashboards; no external worker or browser service is required.

## Build and validate

Requires Node.js 22, npm, and Docker for the companion build against the exact distribution. From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run demo
npm run build
npm run build:companion
```

The companion build creates `build/betterreports-opensearch-3.8.0.zip`. Install it on OpenSearch before using the Dashboards plugin. The Dashboards build creates `build/betterReports-3.8.0.zip` and its SHA-256 checksum. The demo creates `output/pdf/BetterReports-demo.pdf` using clearly identified synthetic data.

`npm run check:platform` verifies integration contracts against the exact 3.8.0 source at `OSD_HOME` or `.platform/OpenSearch-Dashboards`. `npm run build:platform` performs that check before packaging. The archive uses the 3.8.0 bundle registry and platform-shared React/EUI dependencies; it does not require bootstrapping the complete Dashboards monorepo.

## Install

Install the OpenSearch companion on every OpenSearch node, enable `plugins.security.system_indices.enabled: true`, and follow the [deployment guide](docs/DEPLOYMENT.md) for role mappings, the restricted worker identity, and Notifications configuration. Upgrading from 0.0.1 requires removing BetterReports SMTP settings and selecting Notifications senders/groups for existing schedules.

```sh
bin/opensearch-plugin install file:///absolute/path/betterreports-opensearch-3.8.0.zip
```

Install the ZIP into a self-hosted OpenSearch Dashboards **3.8.0** installation, configure the permissions and services described in [Deployment](docs/DEPLOYMENT.md), and restart Dashboards:

```sh
bin/opensearch-dashboards-plugin install file:///absolute/path/betterReports-3.8.0.zip
```

The existing Reporting plugin may remain installed. Open **BetterReports** from the navigation menu, or choose **Share → Create BetterReport** from a saved dashboard or visualization.

1. Select saved sources and explicitly choose supported panels.
2. Arrange sections, set the reporting interval, and customize branding.
3. Generate a preview, then save the reusable report definition.
4. Authorize the saved report for scheduling, then create a schedule with a timezone, recurrence, Notifications email sender, and recipient groups. Authorization lasts indefinitely until revoked.
5. Inspect progress and delivery results in Run history.

Source configurations are snapshots. Data is queried anew each run. **Refresh sources** deliberately adopts upstream configuration changes; it operates on the saved report, so save local edits first.

## Documentation

- [Deployment, SMTP, grants, SAML roles, and operation](docs/DEPLOYMENT.md)
- [Supported visualizations and known boundaries](docs/SUPPORT.md)
- [Architecture and API](docs/ARCHITECTURE.md)
- [Validation and deployment acceptance](docs/VALIDATION.md)

Reports and PDFs are private to their owner within a Security tenant. Cluster administrators retain their normal control over cluster data. Jobs require a running Dashboards instance; SMTP delivery requires administrator configuration.

## License

Apache-2.0. See LICENSE and NOTICE for dependency notices.
