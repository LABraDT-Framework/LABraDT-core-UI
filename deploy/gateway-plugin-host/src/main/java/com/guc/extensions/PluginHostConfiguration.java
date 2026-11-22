package com.guc.extensions;

import com.guc.dt_framework.adapter.AdapterRegistry;
import com.guc.dt_framework.adapter.ICPPSAdapter;
import com.guc.dt_framework.model.ProtocolType;
import com.guc.dt_framework.translation.ITranslationLayer;
import com.guc.dt_framework.translation.TranslatorRegistry;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

@AutoConfiguration
public class PluginHostConfiguration {
    @Bean
    @ConditionalOnMissingBean(PluginStatus.class)
    public PluginStatus gatewayPluginStatus(ApplicationContext context, TranslatorRegistry translators, AdapterRegistry adapters) throws Exception {
        return new PluginStatus(context, translators, adapters);
    }

    @RestController
    public static class PluginStatus {
        private final List<Map<String,Object>> snapshot = new ArrayList<>();
        private final AdapterRegistry adapters;

        PluginStatus(ApplicationContext context, TranslatorRegistry translators, AdapterRegistry adapters) throws Exception {
            this.adapters = adapters;
            for (ProtocolType protocol : List.of(ProtocolType.OPC_UA, ProtocolType.MQTT)) {
                snapshot.add(new LinkedHashMap<>(Map.of("id", "plugin:" + protocol, "protocol", protocol.name(), "status", translators.hasTranslator(protocol) ? "Loaded" : "Failed", "message", "Bundled Gateway module")));
            }
            Path directory = Path.of(System.getenv().getOrDefault("GUC_GATEWAY_PLUGIN_DIR", "/gateway-plugins"));
            if (Files.isDirectory(directory)) try (var paths = Files.list(directory)) {
                for (Path folder : paths.filter(p -> !p.getFileName().toString().startsWith(".") && !Files.exists(p.resolve(".uninstalled")) && Files.isRegularFile(p.resolve("descriptor.json"))).sorted().toList()) {
                    Map<String,Object> descriptor = new ObjectMapper().readValue(Files.readString(folder.resolve("descriptor.json")), Map.class);
                    Map<String,Object> state = new LinkedHashMap<>();
                    state.put("id", descriptor.get("id")); state.put("protocol", descriptor.get("protocol"));
                    state.put("sha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(folder.resolve("plugin.jar")))));
                    try {
                        ProtocolType protocol = ProtocolType.valueOf((String) descriptor.get("protocol"));
                        ClassLoader loader = context.getClassLoader();
                        Class<?> adapter = Class.forName((String) descriptor.get("adapterClass"), false, loader);
                        Class<?> translator = Class.forName((String) descriptor.get("translatorClass"), false, loader);
                        Class<?> configuration = Class.forName((String) descriptor.get("configurationClass"), false, loader);
                        if (!ICPPSAdapter.class.isAssignableFrom(adapter) || !ITranslationLayer.class.isAssignableFrom(translator)) throw new IllegalStateException("Plugin does not implement Gateway SPI");
                        if (context.getBeanNamesForType(configuration).length == 0 || !translators.hasTranslator(protocol) || !translator.isInstance(translators.getTranslator(protocol))) throw new IllegalStateException("Plugin classes exist but Spring configuration/translator is not active");
                        state.put("status", "Loaded"); state.put("message", "SPI and registered translator verified by running JVM");
                    } catch (Throwable error) {
                        state.put("status", "Failed"); state.put("message", error.getClass().getSimpleName() + ": " + error.getMessage());
                    }
                    snapshot.add(state);
                }
            }
        }

        @GetMapping("/api/plugins")
        public Map<String,Object> plugins() {
            return Map.of("available", true, "plugins", snapshot, "machines", adapters.getAllAdapters().stream().map(adapter -> Map.of("machineId", adapter.getMachineId(), "protocol", adapter.getProtocol().name(), "connected", adapter.isConnected())).toList());
        }
    }
}
