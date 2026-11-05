# OpenSearch Dashboards 3.9.0 with the BetterReports plugin installed.
# Build context: the repository root after `npm run build`.
# Mount opensearch_dashboards.yml (better_reports.* settings) and set BETTER_REPORTS_WORKER_PASSWORD at deploy time; see docs/DEPLOYMENT.md.
FROM opensearchproject/opensearch-dashboards:3.9.0
COPY --chown=opensearch-dashboards:opensearch-dashboards build/betterReports-3.9.0.zip /tmp/betterReports.zip
RUN /usr/share/opensearch-dashboards/bin/opensearch-dashboards-plugin install file:///tmp/betterReports.zip
