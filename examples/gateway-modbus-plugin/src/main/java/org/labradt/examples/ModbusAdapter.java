package org.labradt.examples;

import com.guc.dt_framework.adapter.ICPPSAdapter;
import com.guc.dt_framework.model.*;
import java.io.*;
import java.net.*;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

/** Small, real TCP client example: one unsigned holding register per mapping, unit ID 1.
 * Not a general industrial driver: no coils, RTU, float32, scaling, or multi-register writes. */
public class ModbusAdapter implements ICPPSAdapter {
    private final MachineConfig config;
    private final URI endpoint;
    private volatile boolean connected;
    private int transaction;
    private final Map<String,RawValue> cache = new ConcurrentHashMap<>();
    private final ScheduledExecutorService retry = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "modbus-retry"); t.setDaemon(true); return t; });
    public ModbusAdapter(MachineConfig config) {
        this.config = config; endpoint = URI.create(config.getConnection().getEndpoint());
        if (!"modbus.tcp".equals(endpoint.getScheme()) || endpoint.getHost() == null) throw new IllegalArgumentException("Use modbus.tcp://host:port");
        for (AdapterMapping mapping : config.getMappings()) address(mapping.getSourceAddress());
    }
    public void connect() { retry.scheduleWithFixedDelay(() -> readAddress(config.getMappings().getFirst().getSourceAddress()), 0, 3, TimeUnit.SECONDS); }
    public void disconnect() { retry.shutdownNow(); connected = false; }
    public String getMachineId() { return config.getMachineId(); }
    public ProtocolType getProtocol() { return ProtocolType.MODBUS; }
    public boolean isConnected() { return connected; }
    public Map<String,RawValue> getCachedNodes() { return Map.copyOf(cache); }
    private static int address(String text) {
        if (text == null || !text.matches("holding:[0-9]{1,5}")) throw new IllegalArgumentException("Address must be holding:0 through holding:65535 (zero-based)");
        int value = Integer.parseInt(text.substring(8));
        if (value > 65535) throw new IllegalArgumentException("Holding register address exceeds 65535");
        return value;
    }
    private synchronized byte[] exchange(int function, int register, int value) throws IOException {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(endpoint.getHost(), endpoint.getPort() < 0 ? 502 : endpoint.getPort()), 1500); socket.setSoTimeout(1500);
            DataOutputStream out = new DataOutputStream(socket.getOutputStream()); DataInputStream in = new DataInputStream(socket.getInputStream());
            int tx = (++transaction) & 65535;
            out.writeShort(tx); out.writeShort(0); out.writeShort(6); out.writeByte(1); out.writeByte(function); out.writeShort(register); out.writeShort(value); out.flush();
            int actualTx = in.readUnsignedShort(), protocol = in.readUnsignedShort(), length = in.readUnsignedShort(), unit = in.readUnsignedByte();
            if (actualTx != tx || protocol != 0 || unit != 1 || length < 3 || length > 254) throw new IOException("Invalid Modbus MBAP response");
            byte[] response = in.readNBytes(length - 1);
            if (response.length != length - 1 || (response[0] & 255) != function) throw new IOException("Modbus exception or incomplete response");
            connected = true; return response;
        }
    }
    public RawValue readAddress(String source) {
        try {
            byte[] response = exchange(3, address(source), 1);
            if (response.length != 4 || response[1] != 2) throw new IOException("Expected one holding register");
            int value = ((response[2] & 255) << 8) | (response[3] & 255);
            RawValue raw = new RawValue(source, value, "UInt16", LocalDateTime.now(), ProtocolType.MODBUS, "OK"); cache.put(source, raw); return raw;
        } catch (IOException | IllegalArgumentException error) { connected = false; return new RawValue(source, null, "UInt16", LocalDateTime.now(), ProtocolType.MODBUS, "ERROR: " + error.getMessage()); }
    }
    public List<RawValue> readBatchAddresses(List<String> sources) { return sources.stream().map(this::readAddress).toList(); }
    public void writeAddress(String source, Object value) {
        double number = Double.parseDouble(String.valueOf(value));
        if (!Double.isFinite(number) || number != Math.rint(number) || number < 0 || number > 65535) throw new IllegalArgumentException("Write requires an unsigned 16-bit integer");
        try {
            int register = address(source); byte[] response = exchange(6, register, (int)number);
            if (response.length != 5 || ((response[1] & 255) << 8 | (response[2] & 255)) != register || ((response[3] & 255) << 8 | (response[4] & 255)) != (int)number) throw new IOException("Write echo mismatch");
        } catch (IOException error) { connected = false; throw new IllegalStateException("Modbus write failed", error); }
    }
}
