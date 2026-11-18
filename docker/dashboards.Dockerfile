# OpenSearch Dashboards 3.10.0 with the BetterReports plugin installed.
# Build context: the repository root after `npm run build`.
# Mount opensearch_dashboards.yml (better_reports.* settings) and set BETTER_REPORTS_WORKER_PASSWORD at deploy time; see docs/DEPLOYMENT.md.
# Pinned by digest so a re-pushed upstream tag cannot change a release. Update the digest with the tag.
FROM opensearchproject/opensearch-dashboards:3.10.0@sha256:90e839fc7fb3ac80fbe87b0a08fe378ed9b7cb52fcbafa08840915f2b152bcf1
COPY --chown=opensearch-dashboards:opensearch-dashboards build/betterReports-3.10.0.zip /tmp/betterReports.zip
RUN /usr/share/opensearch-dashboards/bin/opensearch-dashboards-plugin install file:///tmp/betterReports.zip
