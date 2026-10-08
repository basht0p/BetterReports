FROM opensearchproject/opensearch-dashboards:3.9.0
COPY --chown=opensearch-dashboards:opensearch-dashboards build/betterReports-3.9.0.zip /tmp/betterReports.zip
RUN /usr/share/opensearch-dashboards/bin/opensearch-dashboards-plugin install file:///tmp/betterReports.zip
