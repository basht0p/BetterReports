# Deployment

## Requirements

- Self-hosted OpenSearch and OpenSearch Dashboards 3.8.0, with their Security plugins enabled.
- Standard Security tenant mode. Set `opensearch_security.multitenancy.enabled: true` and `opensearch_security.multitenancy.enable_aggregation_view: false`. Disable Workspaces.
- The BetterReports OpenSearch companion plugin on every OpenSearch node, and a dedicated worker identity with only the execute/check/release actions.
- SMTP with a trusted TLS certificate. STARTTLS is mandatory on non-implicit-TLS connections.
- An internal Dashboards storage role with access to BetterReports indices. Ordinary report users should not receive direct access to these indices.

Install the archive with the Dashboards plugin CLI and restart. Install the same version on every Dashboards instance. Keep at least one instance running for schedules. A modest deployment should reserve additional memory for two PDF worker threads (each capped at 256 MiB old-generation memory), chart data, and PDF artifacts.

## Configuration

Add to `opensearch_dashboards.yml`:

```yaml
opensearch.requestHeadersWhitelist:
  - authorization
  - securitytenant

opensearch_security.multitenancy.enabled: true
opensearch_security.multitenancy.enable_aggregation_view: false

better_reports:
  worker:
    username: betterreports_runner
    passwordEnv: BETTER_REPORTS_WORKER_PASSWORD
  smtp:
    host: smtp.example.com
    port: 587
    secure: false
    username: reports@example.com
    passwordEnv: BETTER_REPORTS_SMTP_PASSWORD
    from: reports@example.com
  adminRoles: [all_access]
  limits:
    concurrency: 2
    pages: 20
    rows: 10000
    bytes: 10485760
    timeoutMs: 300000
    artifactDays: 7
    historyDays: 30
    schedules: 100
```

Set the named environment variables through your deployment's secret injection mechanism. Neither secret is stored in report definitions or emitted by the plugin. SMTP authentication may be omitted for a trusted relay; TLS remains required. Use `secure: true` for implicit TLS, normally port 465. Use Node's `NODE_EXTRA_CA_CERTS` at process startup when your relay uses a private CA. Do not disable certificate validation.

The Dashboards internal storage identity is its configured internal OpenSearch user, usually `kibanaserver`. Keep it separate from `betterreports_runner`. The worker has no direct business-data access and no impersonation permission.

## Companion installation and indefinite authorization

Install `build/betterreports-opensearch-3.8.0.zip` on every OpenSearch node using `bin/opensearch-plugin install file:///absolute/path/betterreports-opensearch-3.8.0.zip`, then perform your normal rolling restart. This companion depends on the exact 3.8.0 Security plugin. Enable `plugins.security.system_indices.enabled: true` in OpenSearch configuration. The companion registers its grant index as a protected system index. The resource-sharing experimental feature is not required.

Create the roles in `companion/roles.json` with the Security role API or your configuration management. Map `betterreports_user` to your SAML backend group. Map `betterreports_tenant_manager` only to intended tenant managers; they also need existing tenant access. Map `betterreports_worker` only to the machine identity `betterreports_runner` and inject its password through `BETTER_REPORTS_WORKER_PASSWORD`. No report-owner usernames are needed in OpenSearch configuration.

The companion ZIP also includes `roles.json`. In SAML deployments, keep an internal Basic authentication domain enabled for the machine identity, ordered before the SAML domain, with `challenge: false`. SAML continues to handle interactive users. This ordering is necessary for the worker's Basic credentials to be accepted; a SAML challenge must not intercept them. Grant the worker only the supplied `betterreports_worker` role.

Report owners authorize saved revisions with **Authorize scheduling**. Grants never expire. There is no renewal or stored SAML session, password, or token. The grant records the authenticated identity, backend roles, mapped OpenSearch roles, custom attributes, selected tenant, and approved aggregation queries. Background execution uses that stored role membership and current definitions of those roles, so changing a role's permissions changes grant execution. Removing group membership or disabling the user's IdP account does not revoke existing grants. Use **Authorizations → Revoke authorization** for that purpose. Tenant managers can revoke another owner's grant only in the currently selected authorized tenant.

Report edits and source refresh require new authorization. Existing schedules must reference an authorized current revision. Migrated reports have no grant and cannot run unattended until authorized. Saved source configurations and field formatting are snapshots; background jobs execute approved snapshots without reopening a SAML session. Deleting an upstream dashboard does not revoke a grant: revoke the grant when retiring an authorized report. Interactive import, refresh, and PDF access continue to require the signed-in owner's current tenant/source access.

Grant revocation is checked before each query, after query execution, and before SMTP delivery. A query already in flight can finish, but its results are discarded if revocation is observed. A message already accepted by SMTP cannot be recalled. Workers can execute approved grants and receive their results; they cannot supply arbitrary identities, roles, tenants, or replacement query bodies.

Explicit scheduling authorizations are indefinite. Previews and manual generation instead use temporary run permissions, released after completion, failure, or cancellation. Cleanup is retried after interruption; orphaned one-off permissions stop allowing execution after 24 hours. The worker's `release` action cannot remove a persistent scheduling authorization. These temporary permissions do not appear in the scheduling authorization list.

## Storage permissions

Create a role equivalent to the following and map only the Dashboards internal user to it:

```json
{
  "cluster_permissions": [],
  "index_permissions": [{
    "index_patterns": [".better-reports-v1-*"],
    "allowed_actions": ["indices_all"]
  }],
  "tenant_permissions": []
}
```

Use the Security REST role/mapping APIs or your existing configuration management. The role must permit index creation, searches, sequence-number guarded writes, and delete-by-query cleanup. Normal report owners need their existing source/index/tenant permissions; they do not need access to the internal indices. Avoid assigning broad wildcard-index privileges to ordinary users.

Report definitions, PDFs, and recipient lists reside in OpenSearch and are covered by its disk encryption, transport TLS, backups, and access controls. Cluster administrators can access cluster data using their existing privileges; the plugin's administrator UI does not confer PDF access.

## Operation

Use Administration to inspect the local scheduler heartbeat, queue depth, active jobs, failures, and completion counts. Counters are per instance and reset on process restart. Run history is persistent and includes failure codes. Server logs use run IDs rather than report data or credentials.

Check SMTP message limits, including base64 MIME overhead: a 10 MiB PDF takes approximately 13.4 MiB as a MIME attachment. Configure a lower PDF byte ceiling if needed.

`delivery_unknown` means the relay may have accepted a message. Check mail-server logs using its stable Message-ID before deliberately choosing **Send now / test** again. A run already in `sending` cannot be cancelled safely.

When a report owner leaves or loses access, revoke their authorizations in each tenant, pause their schedules, retain audit history, and create replacement reports under the new owner. Revocation through BetterReports pauses schedules using that grant. Report ownership cannot be changed through the ordinary edit API.

## Upgrade and removal

Back up `.better-reports-v1-*` and the protected `.better-reports-grants-v1` before upgrading. Stop/pause schedules, replace both plugin ZIPs through their normal CLIs, restart, and verify health plus a test report. The plugin does not mutate built-in report definitions or dashboard objects. Removing it does not automatically delete its indices or historical PDFs.

## Troubleshooting

- `NOT_READY`: check the Dashboards log and the internal storage role before restarting.
- `TENANT_FORBIDDEN` / `SOURCE_UNAVAILABLE`: recheck current tenant and saved-object access for the owner. Refresh cannot repair revoked access.
- `GRANT_REQUIRED` / `GRANT_STALE`: authorize the saved report revision. `GRANT_REVOKED`: the owner or tenant manager revoked authorization. `COMPANION_UNAVAILABLE` / `WORKER_NOT_CONFIGURED`: verify companion installation, worker role, and worker secret.
- `INVALID_QUERY` / `UNSUPPORTED_CONFIGURATION`: edit or replace the indicated source; unsupported panels are never captured as screenshots.
- `QUERY_LIMIT`, `LAYOUT_LIMIT`, `PAGE_LIMIT`, or `PDF_SIZE_LIMIT`: reduce the report content or adjust the documented administrative limit. Large metric sections should use a table.
- `SMTP_FAILED`: inspect relay connectivity, STARTTLS trust, sender authorization, and relay logs. `DELIVERY_UNKNOWN` requires a deliberate resend decision.
- Stale browser assets after replacing a development ZIP: hard-refresh the browser. PDF previews intentionally remain stale after report edits until regenerated.
- Slow queues: inspect scheduler health on every instance and OpenSearch write latency. Scheduling and claims use shared indices; no shared disk is needed.

Development fixtures use local generated credentials and a test SMTP sink. Stop them with `docker compose -f dev/compose.yml --profile multi stop`; retain `.platform/dev-secrets.json` locally and never commit it.
