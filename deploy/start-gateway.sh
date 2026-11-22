#!/usr/bin/env bash
set -euo pipefail
# This script runs inside the Gateway container; no Docker socket is exposed.
if [ -d /source ]; then cp -a /source/. /workspace/; fi
cd /workspace
mvn -pl dt-gateway-app -am -DskipTests install
mkdir -p /opt/plugin-host
cp -a /plugin-host-source/. /opt/plugin-host/
mvn -f /opt/plugin-host/pom.xml -DskipTests package
launcher=(-Dloader.path=/opt/plugin-host/target/gateway-plugin-host-0.9.1.jar)
if [ -f /gateway-plugins/loader.properties ]; then
  launcher=(-Dloader.config.location=file:/gateway-plugins/loader.properties)
fi
exec java -Duser.timezone=UTC -Djava.net.preferIPv4Stack=true -Djava.net.preferIPv4Addresses=true "${launcher[@]}" \
  -cp dt-gateway-app/target/dt-gateway-app-0.0.1-SNAPSHOT.jar org.springframework.boot.loader.launch.PropertiesLauncher \
  --server.port=8085 --dt.ui.enabled=false --dt.framework.config-path="${GUC_CONFIG_PATH:-file:/docker-configs}"
