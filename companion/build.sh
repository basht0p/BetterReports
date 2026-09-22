#!/usr/bin/env bash
set -euo pipefail
cd /usr/share/opensearch
mkdir -p /work/companion/build/classes /work/build
jdk/bin/javac --release 21 -encoding UTF-8 -cp 'lib/*:plugins/opensearch-security/*:plugins/opensearch-notifications/*:plugins/opensearch-notifications-core/*' -d /work/companion/build/classes /work/companion/src/main/java/org/betterreports/*.java
jdk/bin/jar --create --file /work/companion/build/betterreports.jar -C /work/companion/build/classes .
cp plugins/opensearch-notifications/common-utils-3.8.0.0.jar /work/companion/build/
cp plugins/opensearch-notifications-core/kotlin-stdlib-2.2.20.jar /work/companion/build/
cp /work/companion/plugin-descriptor.properties /work/companion/build/
cp /work/companion/roles.json /work/companion/build/roles.json
cp /work/LICENSE /work/companion/build/LICENSE
cp /work/NOTICE /work/companion/build/NOTICE
jdk/bin/jar --create --file /work/build/betterreports-opensearch-3.8.0.zip -C /work/companion/build betterreports.jar -C /work/companion/build common-utils-3.8.0.0.jar -C /work/companion/build kotlin-stdlib-2.2.20.jar -C /work/companion/build plugin-descriptor.properties -C /work/companion/build LICENSE -C /work/companion/build NOTICE -C /work/companion/build roles.json
