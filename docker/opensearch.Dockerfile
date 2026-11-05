# OpenSearch 3.9.0 with the BetterReports companion plugin installed.
# Build context: the repository root after `npm run build:companion`.
# Configuration (security, TLS, Notifications senders) is supplied at deploy time; see docs/DEPLOYMENT.md.
FROM opensearchproject/opensearch:3.9.0
COPY build/betterreports-opensearch-3.9.0.zip /tmp/betterreports.zip
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch file:/tmp/betterreports.zip
