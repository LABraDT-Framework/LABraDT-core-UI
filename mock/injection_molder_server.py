"""
Mock OPC UA server for an injection moulding machine.
Runs on port 4841 so it can run alongside the CNC mock (port 4840).

Node layout (namespace 2):
  ns=2;i=1   MachineState      Int32   (0=IDLE, 1=INJECTING, 2=COOLING, 3=EJECTING)
  ns=2;i=2   BarrelTempZone1   Double  °C
  ns=2;i=3   BarrelTempZone2   Double  °C
  ns=2;i=4   MoldTemperature   Double  °C
  ns=2;i=5   InjectionPressure Double  bar
  ns=2;i=6   ClampForce        Double  kN
  ns=2;i=7   CycleTime         Double  s
  ns=2;i=8   ShotCount         Int32
  ns=2;i=9   MaterialType      String  (constant)
  ns=2;i=10  PlasticizingTime  Double  s

Usage:
  pip install asyncua
  python injection_molder_server.py
"""

import math
import signal
import time

from asyncua import ua
from asyncua.sync import Server

MACHINE_URI = "http://example.com/UA/InjectionMolder"
APP_URI     = "urn:example:python:injection-molder-mock"

# Cycle phases and their approximate durations (seconds)
PHASE_IDLE      = 0
PHASE_INJECTING = 1
PHASE_COOLING   = 2
PHASE_EJECTING  = 3

PHASE_DURATIONS = {
    PHASE_IDLE:      2.0,
    PHASE_INJECTING: 4.0,
    PHASE_COOLING:   8.0,
    PHASE_EJECTING:  2.0,
}
FULL_CYCLE = sum(PHASE_DURATIONS.values())   # 16 s total


def current_phase(t: float) -> int:
    """Return the current phase based on elapsed time t (loops every FULL_CYCLE)."""
    pos = t % FULL_CYCLE
    for phase in [PHASE_IDLE, PHASE_INJECTING, PHASE_COOLING, PHASE_EJECTING]:
        if pos < PHASE_DURATIONS[phase]:
            return phase
        pos -= PHASE_DURATIONS[phase]
    return PHASE_IDLE


def main():
    server = Server()
    server.set_endpoint("opc.tcp://0.0.0.0:4841/injection-molder/mock/")
    server.set_server_name("Python Injection Molder Mock Server")
    server.tloop.post(server.aio_obj.set_application_uri(APP_URI))

    idx = server.register_namespace(MACHINE_URI)
    objects = server.nodes.objects

    machine = objects.add_object(idx, "InjectionMolder1")

    # String NodeIds — unique by name, no numeric conflicts
    node_state    = machine.add_variable(ua.NodeId("MachineState",           idx), "MachineState",           0,     ua.VariantType.Int32)
    node_btemp1   = machine.add_variable(ua.NodeId("BarrelTemperatureZone1", idx), "BarrelTemperatureZone1", 220.0, ua.VariantType.Double)
    node_btemp2   = machine.add_variable(ua.NodeId("BarrelTemperatureZone2", idx), "BarrelTemperatureZone2", 230.0, ua.VariantType.Double)
    node_mtemp    = machine.add_variable(ua.NodeId("MoldTemperature",        idx), "MoldTemperature",        45.0,  ua.VariantType.Double)
    node_pressure = machine.add_variable(ua.NodeId("InjectionPressure",      idx), "InjectionPressure",      0.0,   ua.VariantType.Double)
    node_clamp    = machine.add_variable(ua.NodeId("ClampForce",             idx), "ClampForce",             1800.0,ua.VariantType.Double)
    node_cycle    = machine.add_variable(ua.NodeId("CycleTime",              idx), "CycleTime",              0.0,   ua.VariantType.Double)
    node_shots    = machine.add_variable(ua.NodeId("ShotCount",              idx), "ShotCount",              0,     ua.VariantType.Int32)
    node_material = machine.add_variable(ua.NodeId("MaterialType",           idx), "MaterialType",           "ABS", ua.VariantType.String)
    node_plastime = machine.add_variable(ua.NodeId("PlasticizingTime",       idx), "PlasticizingTime",       0.0,   ua.VariantType.Double)
    # Extra signal not in the base template — demonstrates an instance adding
    # an element on top of an included fragment (molder-1.json).
    node_screwpos = machine.add_variable(ua.NodeId("ScrewPosition",          idx), "ScrewPosition",          0.0,   ua.VariantType.Double)

    for node in [node_state, node_btemp1, node_btemp2, node_mtemp,
                 node_pressure, node_clamp, node_cycle, node_shots, node_plastime,
                 node_screwpos]:
        node.set_writable()

    stop_requested = False

    def _stop(_sig, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    print("Starting OPC UA Injection Molder mock server at opc.tcp://0.0.0.0:4841/")
    print("Nodes: ns=2;i=1 … ns=2;i=10  |  Press Ctrl+C to stop.")

    shot_count = 0
    last_phase = -1
    cycle_start = 0.0

    with server:
        start = time.monotonic()

        while not stop_requested:
            t = time.monotonic() - start
            phase = current_phase(t)

            # Track shot completions (EJECTING → IDLE transition)
            if last_phase == PHASE_EJECTING and phase == PHASE_IDLE:
                shot_count += 1
                cycle_start = t
            if last_phase == -1:
                cycle_start = t
            last_phase = phase

            # ── barrel temperatures: slowly oscillate around set-points ──
            btemp1 = 220.0 + 3.0 * math.sin(t * 0.05)
            btemp2 = 230.0 + 2.5 * math.sin(t * 0.04 + 0.5)

            # ── mold temperature: rises during injection/cooling, dips at eject ──
            mtemp = 45.0 + 8.0 * math.sin(t * (2 * math.pi / FULL_CYCLE))

            # ── phase-dependent signals ──
            if phase == PHASE_IDLE:
                pressure    = 0.0
                clamp       = 200.0
                plastime    = 3.5 + 0.2 * math.sin(t * 0.3)
            elif phase == PHASE_INJECTING:
                pressure    = 1600.0 + 200.0 * math.sin(t * 1.5)
                clamp       = 2200.0 + 50.0 * math.sin(t * 0.8)
                plastime    = 3.5 + 0.2 * math.sin(t * 0.3)
            elif phase == PHASE_COOLING:
                pressure    = 800.0 + 50.0 * math.sin(t * 0.5)   # hold pressure
                clamp       = 2200.0
                plastime    = 3.5 + 0.2 * math.sin(t * 0.3)
            else:  # EJECTING
                pressure    = 0.0
                clamp       = 100.0
                plastime    = 3.5 + 0.2 * math.sin(t * 0.3)

            cycle_elapsed = t - cycle_start

            # Screw fully forward (0 mm) while injecting, retracts to ~120 mm otherwise.
            if phase == PHASE_INJECTING:
                screw_pos = 5.0 + 3.0 * math.sin(t * 1.5)
            else:
                screw_pos = 120.0 + 10.0 * math.sin(t * 0.3)

            node_state.write_value(phase,          ua.VariantType.Int32)
            node_btemp1.write_value(btemp1,        ua.VariantType.Double)
            node_btemp2.write_value(btemp2,        ua.VariantType.Double)
            node_mtemp.write_value(mtemp,          ua.VariantType.Double)
            node_pressure.write_value(pressure,    ua.VariantType.Double)
            node_clamp.write_value(clamp,          ua.VariantType.Double)
            node_cycle.write_value(cycle_elapsed,  ua.VariantType.Double)
            node_shots.write_value(shot_count,     ua.VariantType.Int32)
            node_plastime.write_value(plastime,    ua.VariantType.Double)
            node_screwpos.write_value(screw_pos,   ua.VariantType.Double)

            time.sleep(1.0)

    print("Injection Molder mock server stopped.")


if __name__ == "__main__":
    main()
