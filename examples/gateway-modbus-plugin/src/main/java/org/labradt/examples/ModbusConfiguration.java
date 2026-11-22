package org.labradt.examples;

import com.guc.dt_framework.adapter.*;
import com.guc.dt_framework.model.*;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import java.util.*;

@AutoConfiguration
@ConditionalOnProperty(prefix="dt.adapter.modbus", name="enabled", havingValue="true")
public class ModbusConfiguration {
    @Bean public AdapterPool modbusAdapters(MachineConfigLoader loader) {
        List<ICPPSAdapter> adapters = new ArrayList<>();
        for (MachineConfig config : loader.loadAll()) if (config.getProtocol() == ProtocolType.MODBUS) {
            ModbusAdapter adapter = new ModbusAdapter(config); adapter.connect(); adapters.add(adapter);
        }
        return () -> adapters;
    }
    @Bean public ModbusTranslator modbusTranslator() { return new ModbusTranslator(); }
}
