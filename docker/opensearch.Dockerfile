# OpenSearch 3.10.0 with the BetterReports companion plugin installed.
# Build context: the repository root after `npm run build:companion`.
# Configuration (security, TLS, Notifications senders) is supplied at deploy time; see docs/DEPLOYMENT.md.
# Pinned by digest so a re-pushed upstream tag cannot change a release. Update the digest with the tag.
FROM opensearchproject/opensearch:3.10.0@sha256:02d6d6e40c820ae08233b60540aa5d3d9364d64e2dc724e38d6c8c794879b2a0
COPY build/betterreports-opensearch-3.10.0.zip /tmp/betterreports.zip
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch file:/tmp/betterreports.zip
