FROM opensearchproject/opensearch:3.8.0
COPY build/betterreports-opensearch-3.8.0.zip /tmp/betterreports.zip
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch file:/tmp/betterreports.zip
