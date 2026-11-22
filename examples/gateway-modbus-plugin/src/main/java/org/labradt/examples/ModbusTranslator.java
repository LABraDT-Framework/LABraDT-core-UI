package org.labradt.examples;

import com.guc.dt_framework.translation.ITranslationLayer;
import com.guc.dt_framework.model.*;
import java.time.LocalDateTime;

public class ModbusTranslator implements ITranslationLayer {
    public ProtocolType getProtocol() { return ProtocolType.MODBUS; }
    public boolean supportsProtocol(ProtocolType protocol) { return protocol == getProtocol(); }
    public SubmodelElement translateValue(RawValue raw, AdapterMapping mapping) {
        SubmodelElement element = new SubmodelElement();
        element.setIdShort(mapping.getIdShort()); element.setCategory(mapping.getCategory()); element.setSemanticId(mapping.getSemanticId());
        element.setValueType(mapping.getValueType()); element.setRoutingKey(mapping.routingKey()); element.setUnit(mapping.getUnit()); element.setDeadband(mapping.getDeadband());
        element.setValue(raw.getValue() == null ? null : String.valueOf(raw.getValue())); element.setTimestamp(raw.getTimestamp()); element.setStatusCode(raw.getStatusCode());
        double[] range = mapping.getValidRange();
        if (raw.getValue() instanceof Number value && range != null && range.length == 2 && (value.doubleValue() < range[0] || value.doubleValue() > range[1])) element.setStatusCode("OUT_OF_RANGE");
        return element;
    }
    public RawValue reverseTranslateElement(SubmodelElement element, AdapterMapping mapping) { return new RawValue(mapping.getSourceAddress(), element.getValue(), "UInt16", LocalDateTime.now(), getProtocol(), "OK"); }
}
