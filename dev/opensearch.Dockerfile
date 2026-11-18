FROM opensearchproject/opensearch:3.10.0
COPY build/betterreports-opensearch-3.10.0.zip /tmp/betterreports.zip
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch file:/tmp/betterreports.zip
