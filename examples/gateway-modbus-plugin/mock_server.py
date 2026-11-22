"""Local demonstration only. Modbus TCP unit 1; holding register 0 starts at 37."""
import socketserver
import struct
import threading

registers = {0: 37}
lock = threading.Lock()

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        header = self.rfile.read(7)
        if len(header) != 7: return
        tx, protocol, length, unit = struct.unpack('>HHHB', header)
        if protocol or not 2 <= length <= 254: return
        pdu = self.rfile.read(length - 1)
        if len(pdu) != 5: return
        function, address, value = struct.unpack('>BHH', pdu)
        with lock:
            if unit != 1: response = bytes([function | 128, 11])
            elif function == 3 and value == 1: response = struct.pack('>BBH', 3, 2, registers.get(address, 0))
            elif function == 6: registers[address] = value; response = pdu
            else: response = bytes([function | 128, 3])
        self.wfile.write(struct.pack('>HHHB', tx, 0, len(response) + 1, unit) + response)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    with Server(('0.0.0.0', 1502), Handler) as server:
        print('Modbus example listening on 1502', flush=True)
        server.serve_forever()
