import math
import signal
import time
from typing import Dict

from asyncua import ua
from asyncua.sync import Server


CNC_URI = "http://opcfoundation.org/UA/CNC"
APP_URI = "urn:example:python:cnc-mock-server"

# Placeholder enum-like values for mocked CNC state
AXIS_STATUS_ACTIVE = 1
CHANNEL_STATUS_ACTIVE = 1
PROGRAM_STATUS_RUNNING = 2
SPINDLE_STATUS_RUNNING = 1
TURN_DIRECTION_CW = 1
TURN_DIRECTION_CCW = 2
OP_MODE_AUTO = 1
OP_MODE_MDI = 2


def add_var(parent, idx, name, value, varianttype=None):
    return parent.add_variable(idx, name, value, varianttype=varianttype)


def add_obj(parent, idx, name):
    return parent.add_object(idx, name)


def build_range(parent, idx, name="EURange"):
    obj = add_obj(parent, idx, name)
    add_var(obj, idx, "Low", 0.0, ua.VariantType.Double)
    add_var(obj, idx, "High", 0.0, ua.VariantType.Double)
    return obj


def build_eu_info(parent, idx, name="EngineeringUnits"):
    obj = add_obj(parent, idx, name)
    add_var(obj, idx, "NamespaceUri", "", ua.VariantType.String)
    add_var(obj, idx, "UnitId", 0, ua.VariantType.Int32)
    add_var(obj, idx, "DisplayName", "", ua.VariantType.String)
    add_var(obj, idx, "Description", "", ua.VariantType.String)
    return obj


def build_position(parent, idx, name):
    obj = add_obj(parent, idx, name)
    add_var(obj, idx, "Value", 0.0, ua.VariantType.Double)
    add_var(obj, idx, "ActPos", 0.0, ua.VariantType.Double)
    add_var(obj, idx, "CmdPos", 0.0, ua.VariantType.Double)
    build_range(obj, idx, "EURange")
    build_eu_info(obj, idx, "EngineeringUnits")
    add_var(obj, idx, "RemDist", 0.0, ua.VariantType.Double)
    return obj


def build_spindle1(parent, idx):
    spindle1 = add_obj(parent, idx, "Spindle1")
    add_var(spindle1, idx, "ActChannel", ua.NodeId(), ua.VariantType.NodeId)
    add_var(spindle1, idx, "ActGear", 0, ua.VariantType.UInt32)
    add_var(spindle1, idx, "ActLoad", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "ActOverride", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "ActPower", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "ActSpeed", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "ActStatus", 0, ua.VariantType.Int32)
    add_var(spindle1, idx, "ActTorque", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "ActTurnDirection", 0, ua.VariantType.Int32)
    build_position(spindle1, idx, "AnglePos")
    add_var(spindle1, idx, "CmdGear", 0, ua.VariantType.UInt32)
    add_var(spindle1, idx, "CmdOverride", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "CmdSpeed", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "CmdTorque", 0.0, ua.VariantType.Double)
    add_var(spindle1, idx, "IsInactive", False, ua.VariantType.Boolean)
    add_var(spindle1, idx, "IsVirtual", False, ua.VariantType.Boolean)
    return spindle1


def build_channel1(parent, idx):
    ch = add_obj(parent, idx, "Channel1")
    add_var(ch, idx, "ParentNodeId", ua.NodeId(), ua.VariantType.NodeId)
    add_var(ch, idx, "ActFeedrate", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "ActGFunctions", 0, ua.VariantType.UInt32)
    add_var(ch, idx, "ActJogIncrement", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "ActMFunctions", 0, ua.VariantType.UInt32)
    add_var(ch, idx, "ActMainProgramFile", "", ua.VariantType.String)
    add_var(ch, idx, "ActMainProgramName", "", ua.VariantType.String)
    add_var(ch, idx, "ActModalOffsetFunction", 0, ua.VariantType.UInt32)
    add_var(ch, idx, "ActOperationMode", 0, ua.VariantType.Int32)
    add_var(ch, idx, "ActOverride", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "ActProgramBlock", "", ua.VariantType.String)
    add_var(ch, idx, "ActProgramFile", "", ua.VariantType.String)
    add_var(ch, idx, "ActProgramFileOffset", 0, ua.VariantType.UInt32)
    add_var(ch, idx, "ActProgramLine", "", ua.VariantType.String)
    add_var(ch, idx, "ActProgramName", "", ua.VariantType.String)
    add_var(ch, idx, "ActProgramStatus", 0, ua.VariantType.Int32)
    add_var(ch, idx, "ActStatus", 0, ua.VariantType.Int32)
    add_var(ch, idx, "BlockMode", False, ua.VariantType.Boolean)
    add_var(ch, idx, "CmdFeedrate", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "CmdOperationMode", 0, ua.VariantType.Int32)
    add_var(ch, idx, "CmdOverride", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "DryRunFeed", 0.0, ua.VariantType.Double)
    add_var(ch, idx, "FeedHold", False, ua.VariantType.Boolean)
    add_var(ch, idx, "Id", 1, ua.VariantType.UInt32)

    for name in [
        "PosTcpBcsA", "PosTcpBcsB", "PosTcpBcsC",
        "PosTcpBcsX", "PosTcpBcsY", "PosTcpBcsZ",
        "PosTcpWcsA", "PosTcpWcsB", "PosTcpWcsC",
        "PosTcpWcsX", "PosTcpWcsY", "PosTcpWcsZ",
    ]:
        build_position(ch, idx, name)

    add_var(ch, idx, "ToolId", 0, ua.VariantType.UInt32)
    return ch


def build_axis(parent, idx, name, rotational=False):
    axis = add_obj(parent, idx, name)
    add_var(axis, idx, "ActChannel", ua.NodeId(), ua.VariantType.NodeId)
    add_var(axis, idx, "ActLoad", 0.0, ua.VariantType.Double)
    add_var(axis, idx, "ActPower", 0.0, ua.VariantType.Double)
    add_var(axis, idx, "ActStatus", 0, ua.VariantType.Int32)
    add_var(axis, idx, "ActTorque", 0.0, ua.VariantType.Double)
    add_var(axis, idx, "CmdTorque", 0.0, ua.VariantType.Double)
    add_var(axis, idx, "IsInactive", False, ua.VariantType.Boolean)
    add_var(axis, idx, "IsReferenced", True, ua.VariantType.Boolean)
    add_var(axis, idx, "IsRotational", rotational, ua.VariantType.Boolean)
    add_var(axis, idx, "IsVirtual", False, ua.VariantType.Boolean)
    build_position(axis, idx, "PosDirect")
    build_position(axis, idx, "PosIndirect")
    add_var(axis, idx, "ZeroOffset", 0.0, ua.VariantType.Double)
    add_var(axis, idx, "TODO:WriteHere", "None", ua.VariantType.String)
    return axis


def build_cnc_interface(parent, idx, name="CNCInterface"):
    cnc = add_obj(parent, idx, name)

    # Stable string NodeIds are used for the two rule-specific signals so the
    # Gateway mapping does not depend on asyncua's generated numeric NodeIds.
    cnc.add_variable(
        ua.NodeId("Temperature", idx),
        ua.QualifiedName("Temperature", idx),
        78.0,
        ua.VariantType.Double,
    )
    cnc.add_variable(
        ua.NodeId("XAxisPos", idx),
        ua.QualifiedName("XAxisPos", idx),
        "0.000000,0.000000,0.000000",
        ua.VariantType.String,
    )

    axis_list = add_obj(cnc, idx, "CnCAxisList")
    build_axis(axis_list, idx, "XAxis", rotational=False)
    build_axis(axis_list, idx, "YAxis", rotational=False)
    build_axis(axis_list, idx, "ZAxis", rotational=False)

    channel_list = add_obj(cnc, idx, "CncChannelList")
    build_channel1(channel_list, idx)

    spindle_list = add_obj(cnc, idx, "CncSpindelList")
    build_spindle1(spindle_list, idx)

    add_var(cnc, idx, "VendorName", "MockVendor", ua.VariantType.String)
    add_var(cnc, idx, "VendorRevision", "0.1", ua.VariantType.String)
    add_var(cnc, idx, "Version", "1.0", ua.VariantType.String)
    return cnc


def make_all_variables_writable(node):
    for child_node in node.get_children():
        node_class = child_node.read_node_class()
        if node_class == ua.NodeClass.Variable:
            child_node.set_writable()
        else:
            make_all_variables_writable(child_node)


def child(node, idx, *names):
    return node.get_child([f"{idx}:{name}" for name in names])


def position_nodes(parent, idx, name) -> Dict[str, object]:
    obj = child(parent, idx, name)
    return {
        "obj": obj,
        "Value": child(obj, idx, "Value"),
        "ActPos": child(obj, idx, "ActPos"),
        "CmdPos": child(obj, idx, "CmdPos"),
        "RemDist": child(obj, idx, "RemDist"),
        "RangeLow": child(obj, idx, "EURange", "Low"),
        "RangeHigh": child(obj, idx, "EURange", "High"),
        "UnitNs": child(obj, idx, "EngineeringUnits", "NamespaceUri"),
        "UnitId": child(obj, idx, "EngineeringUnits", "UnitId"),
        "UnitDisplayName": child(obj, idx, "EngineeringUnits", "DisplayName"),
        "UnitDescription": child(obj, idx, "EngineeringUnits", "Description"),
    }


def write(node, value, varianttype=None):
    if varianttype is None:
        node.write_value(value)
    else:
        node.write_value(value, varianttype)


def configure_position_units(pos, low, high, unit_id, display_name, description):
    write(pos["RangeLow"], float(low), ua.VariantType.Double)
    write(pos["RangeHigh"], float(high), ua.VariantType.Double)
    write(pos["UnitNs"], "http://www.opcfoundation.org/UA/units/un/cefact", ua.VariantType.String)
    write(pos["UnitId"], int(unit_id), ua.VariantType.Int32)
    write(pos["UnitDisplayName"], display_name, ua.VariantType.String)
    write(pos["UnitDescription"], description, ua.VariantType.String)


def update_position(pos, actual, commanded):
    write(pos["Value"], float(actual), ua.VariantType.Double)
    write(pos["ActPos"], float(actual), ua.VariantType.Double)
    write(pos["CmdPos"], float(commanded), ua.VariantType.Double)
    write(pos["RemDist"], abs(float(commanded) - float(actual)), ua.VariantType.Double)


def main():
    # Optional CLI port arg so several CNC mocks can run at once:
    #   python sample_server.py        → port 4840 (default)
    #   python sample_server.py 4842   → port 4842 (second CNC instance)
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4840

    server = Server()
    server.set_endpoint(f"opc.tcp://0.0.0.0:{port}/cnc/mock/server/")
    server.set_server_name(f"Python CNC Mock Server (port {port})")
    server.tloop.post(server.aio_obj.set_application_uri(APP_URI))

    idx = server.register_namespace(CNC_URI)
    objects = server.nodes.objects

    machine = objects.add_object(idx, "Machine1")
    cnc = build_cnc_interface(machine, idx, "CNCInterface")
    make_all_variables_writable(cnc)

    vendor_name = child(cnc, idx, "VendorName")
    vendor_revision = child(cnc, idx, "VendorRevision")
    version = child(cnc, idx, "Version")
    temperature = child(cnc, idx, "Temperature")
    x_axis_position = child(cnc, idx, "XAxisPos")
    write(vendor_name, "MockVendor", ua.VariantType.String)
    write(vendor_revision, "rev-2026.03", ua.VariantType.String)
    write(version, "1.0.0", ua.VariantType.String)

    channel1 = child(cnc, idx, "CncChannelList", "Channel1")
    spindle1 = child(cnc, idx, "CncSpindelList", "Spindle1")
    x_axis = child(cnc, idx, "CnCAxisList", "XAxis")
    y_axis = child(cnc, idx, "CnCAxisList", "YAxis")
    z_axis = child(cnc, idx, "CnCAxisList", "ZAxis")

    channel_parent_node = child(channel1, idx, "ParentNodeId")
    channel_id = child(channel1, idx, "Id")
    channel_tool_id = child(channel1, idx, "ToolId")

    x_act_channel = child(x_axis, idx, "ActChannel")
    y_act_channel = child(y_axis, idx, "ActChannel")
    z_act_channel = child(z_axis, idx, "ActChannel")
    spindle_act_channel = child(spindle1, idx, "ActChannel")

    write(channel_parent_node, channel1.nodeid, ua.VariantType.NodeId)
    write(x_act_channel, channel1.nodeid, ua.VariantType.NodeId)
    write(y_act_channel, channel1.nodeid, ua.VariantType.NodeId)
    write(z_act_channel, channel1.nodeid, ua.VariantType.NodeId)
    write(spindle_act_channel, channel1.nodeid, ua.VariantType.NodeId)
    write(channel_id, 1, ua.VariantType.UInt32)

    act_feedrate = child(channel1, idx, "ActFeedrate")
    act_g = child(channel1, idx, "ActGFunctions")
    act_jog = child(channel1, idx, "ActJogIncrement")
    act_m = child(channel1, idx, "ActMFunctions")
    act_main_program_file = child(channel1, idx, "ActMainProgramFile")
    act_main_program_name = child(channel1, idx, "ActMainProgramName")
    act_modal_offset = child(channel1, idx, "ActModalOffsetFunction")
    act_operation_mode = child(channel1, idx, "ActOperationMode")
    act_override = child(channel1, idx, "ActOverride")
    act_program_block = child(channel1, idx, "ActProgramBlock")
    act_program_file = child(channel1, idx, "ActProgramFile")
    act_program_file_offset = child(channel1, idx, "ActProgramFileOffset")
    act_program_line = child(channel1, idx, "ActProgramLine")
    act_program_name = child(channel1, idx, "ActProgramName")
    act_program_status = child(channel1, idx, "ActProgramStatus")
    act_status = child(channel1, idx, "ActStatus")
    block_mode = child(channel1, idx, "BlockMode")
    cmd_feedrate = child(channel1, idx, "CmdFeedrate")
    cmd_operation_mode = child(channel1, idx, "CmdOperationMode")
    cmd_override = child(channel1, idx, "CmdOverride")
    dry_run_feed = child(channel1, idx, "DryRunFeed")
    feed_hold = child(channel1, idx, "FeedHold")

    axis_nodes = {
        "x": {
            "node": x_axis,
            "ActLoad": child(x_axis, idx, "ActLoad"),
            "ActPower": child(x_axis, idx, "ActPower"),
            "ActStatus": child(x_axis, idx, "ActStatus"),
            "ActTorque": child(x_axis, idx, "ActTorque"),
            "CmdTorque": child(x_axis, idx, "CmdTorque"),
            "IsInactive": child(x_axis, idx, "IsInactive"),
            "IsReferenced": child(x_axis, idx, "IsReferenced"),
            "IsRotational": child(x_axis, idx, "IsRotational"),
            "IsVirtual": child(x_axis, idx, "IsVirtual"),
            "ZeroOffset": child(x_axis, idx, "ZeroOffset"),
            "PosDirect": position_nodes(x_axis, idx, "PosDirect"),
            "PosIndirect": position_nodes(x_axis, idx, "PosIndirect"),
        },
        "y": {
            "node": y_axis,
            "ActLoad": child(y_axis, idx, "ActLoad"),
            "ActPower": child(y_axis, idx, "ActPower"),
            "ActStatus": child(y_axis, idx, "ActStatus"),
            "ActTorque": child(y_axis, idx, "ActTorque"),
            "CmdTorque": child(y_axis, idx, "CmdTorque"),
            "IsInactive": child(y_axis, idx, "IsInactive"),
            "IsReferenced": child(y_axis, idx, "IsReferenced"),
            "IsRotational": child(y_axis, idx, "IsRotational"),
            "IsVirtual": child(y_axis, idx, "IsVirtual"),
            "ZeroOffset": child(y_axis, idx, "ZeroOffset"),
            "PosDirect": position_nodes(y_axis, idx, "PosDirect"),
            "PosIndirect": position_nodes(y_axis, idx, "PosIndirect"),
        },
        "z": {
            "node": z_axis,
            "ActLoad": child(z_axis, idx, "ActLoad"),
            "ActPower": child(z_axis, idx, "ActPower"),
            "ActStatus": child(z_axis, idx, "ActStatus"),
            "ActTorque": child(z_axis, idx, "ActTorque"),
            "CmdTorque": child(z_axis, idx, "CmdTorque"),
            "IsInactive": child(z_axis, idx, "IsInactive"),
            "IsReferenced": child(z_axis, idx, "IsReferenced"),
            "IsRotational": child(z_axis, idx, "IsRotational"),
            "IsVirtual": child(z_axis, idx, "IsVirtual"),
            "ZeroOffset": child(z_axis, idx, "ZeroOffset"),
            "PosDirect": position_nodes(z_axis, idx, "PosDirect"),
            "PosIndirect": position_nodes(z_axis, idx, "PosIndirect"),
        },
    }

    spindle_nodes = {
        "ActGear": child(spindle1, idx, "ActGear"),
        "ActLoad": child(spindle1, idx, "ActLoad"),
        "ActOverride": child(spindle1, idx, "ActOverride"),
        "ActPower": child(spindle1, idx, "ActPower"),
        "ActSpeed": child(spindle1, idx, "ActSpeed"),
        "ActStatus": child(spindle1, idx, "ActStatus"),
        "ActTorque": child(spindle1, idx, "ActTorque"),
        "ActTurnDirection": child(spindle1, idx, "ActTurnDirection"),
        "AnglePos": position_nodes(spindle1, idx, "AnglePos"),
        "CmdGear": child(spindle1, idx, "CmdGear"),
        "CmdOverride": child(spindle1, idx, "CmdOverride"),
        "CmdSpeed": child(spindle1, idx, "CmdSpeed"),
        "CmdTorque": child(spindle1, idx, "CmdTorque"),
        "IsInactive": child(spindle1, idx, "IsInactive"),
        "IsVirtual": child(spindle1, idx, "IsVirtual"),
    }

    channel_positions = {
        name: position_nodes(channel1, idx, name)
        for name in [
            "PosTcpBcsA", "PosTcpBcsB", "PosTcpBcsC",
            "PosTcpBcsX", "PosTcpBcsY", "PosTcpBcsZ",
            "PosTcpWcsA", "PosTcpWcsB", "PosTcpWcsC",
            "PosTcpWcsX", "PosTcpWcsY", "PosTcpWcsZ",
        ]
    }

    for key in ["x", "y", "z"]:
        configure_position_units(axis_nodes[key]["PosDirect"], -1000.0, 1000.0, 4408652, "mm", "millimetre")
        configure_position_units(axis_nodes[key]["PosIndirect"], -1000.0, 1000.0, 4408652, "mm", "millimetre")

    configure_position_units(spindle_nodes["AnglePos"], -360.0, 360.0, 4408653, "deg", "degree")

    for name in ["PosTcpBcsX", "PosTcpBcsY", "PosTcpBcsZ", "PosTcpWcsX", "PosTcpWcsY", "PosTcpWcsZ"]:
        configure_position_units(channel_positions[name], -1000.0, 1000.0, 4408652, "mm", "millimetre")

    for name in ["PosTcpBcsA", "PosTcpBcsB", "PosTcpBcsC", "PosTcpWcsA", "PosTcpWcsB", "PosTcpWcsC"]:
        configure_position_units(channel_positions[name], -360.0, 360.0, 4408653, "deg", "degree")

    for key in ["x", "y", "z"]:
        write(axis_nodes[key]["ActStatus"], AXIS_STATUS_ACTIVE, ua.VariantType.Int32)
        write(axis_nodes[key]["IsInactive"], False, ua.VariantType.Boolean)
        write(axis_nodes[key]["IsReferenced"], True, ua.VariantType.Boolean)
        write(axis_nodes[key]["IsVirtual"], False, ua.VariantType.Boolean)

    write(axis_nodes["x"]["IsRotational"], False, ua.VariantType.Boolean)
    write(axis_nodes["y"]["IsRotational"], False, ua.VariantType.Boolean)
    write(axis_nodes["z"]["IsRotational"], False, ua.VariantType.Boolean)

    write(spindle_nodes["ActGear"], 1, ua.VariantType.UInt32)
    write(spindle_nodes["CmdGear"], 1, ua.VariantType.UInt32)
    write(spindle_nodes["IsInactive"], False, ua.VariantType.Boolean)
    write(spindle_nodes["IsVirtual"], False, ua.VariantType.Boolean)

    write(act_main_program_file, "/cnc/programs/demo_main.mpf", ua.VariantType.String)
    write(act_main_program_name, "DEMO_MAIN", ua.VariantType.String)
    write(act_program_file, "/cnc/programs/demo_part.nc", ua.VariantType.String)
    write(act_program_name, "DEMO_PART", ua.VariantType.String)
    write(act_modal_offset, 54, ua.VariantType.UInt32)
    write(act_g, 1, ua.VariantType.UInt32)
    write(act_jog, 0.1, ua.VariantType.Double)
    write(act_status, CHANNEL_STATUS_ACTIVE, ua.VariantType.Int32)
    write(act_program_status, PROGRAM_STATUS_RUNNING, ua.VariantType.Int32)
    write(act_operation_mode, OP_MODE_AUTO, ua.VariantType.Int32)
    write(cmd_operation_mode, OP_MODE_AUTO, ua.VariantType.Int32)
    write(block_mode, False, ua.VariantType.Boolean)

    stop_requested = False

    def _stop_handler(_sig, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGINT, _stop_handler)
    signal.signal(signal.SIGTERM, _stop_handler)

    print(f"Starting OPC UA CNC mock server at opc.tcp://0.0.0.0:{port}/cnc/mock/server/")
    print("Press Ctrl+C to stop.")

    with server:
        start = time.monotonic()

        while not stop_requested:
            t = time.monotonic() - start

            x_cmd = 420.0 + 110.0 * math.sin(t * 0.20)
            y_cmd = 180.0 + 75.0 * math.cos(t * 0.17)
            z_cmd = -35.0 + 25.0 * math.sin(t * 0.27)
            a_cmd = 5.0 * math.sin(t * 0.09)
            b_cmd = 3.0 * math.cos(t * 0.07)
            c_cmd = (t * 15.0) % 360.0

            x_act = x_cmd - 0.8 * math.sin(t * 1.10)
            y_act = y_cmd - 0.6 * math.cos(t * 0.90)
            z_act = z_cmd - 0.4 * math.sin(t * 1.30)
            a_act = a_cmd - 0.05 * math.sin(t * 0.70)
            b_act = b_cmd - 0.05 * math.cos(t * 0.80)
            c_act = c_cmd - 0.8 * math.sin(t * 0.20)

            # Keep normal operation below the rule thresholds. Tests and UI
            # users can PATCH these writable nodes to inject deterministic
            # over-temperature and out-of-bounds conditions.
            temperature_value = 78.0 + 4.0 * math.sin(t * 0.12)
            position_vector = (
                0.30 * math.sin(t * 0.20),
                0.20 * math.cos(t * 0.17),
                -0.04 + 0.02 * math.sin(t * 0.27),
            )
            write(temperature, temperature_value, ua.VariantType.Double)
            write(
                x_axis_position,
                ",".join(f"{value:.6f}" for value in position_vector),
                ua.VariantType.String,
            )

            spindle_cmd_speed = 6000.0 + 1500.0 * math.sin(t * 0.50)
            spindle_act_speed = spindle_cmd_speed - 80.0 * math.sin(t * 2.00)
            spindle_cmd_torque = 24.0 + 2.0 * math.sin(t * 0.40)
            spindle_act_torque = spindle_cmd_torque - 0.7 * math.cos(t * 0.60)
            spindle_power = spindle_act_speed * spindle_act_torque / 9550.0
            spindle_load = 40.0 + 15.0 * math.sin(t * 0.55)
            spindle_override = 100.0 + 5.0 * math.sin(t * 0.25)

            feed_cmd = 1500.0 + 250.0 * math.sin(t * 0.30)
            feed_act = feed_cmd - 20.0 * math.sin(t * 1.20)
            feed_override_val = 100.0 + 8.0 * math.cos(t * 0.20)
            dry_run = 0.0 if int(t / 45.0) % 2 == 0 else 500.0
            hold = int(t / 30.0) % 6 == 5

            line_no = int((t * 3.0) % 250) + 1
            file_offset = line_no * 28
            block = f"N{line_no*10} G1 X{x_cmd:.3f} Y{y_cmd:.3f} Z{z_cmd:.3f} F{feed_cmd:.1f}"
            tool_id = 7 + (int(t / 20.0) % 4)
            turn_direction = TURN_DIRECTION_CW if math.sin(t * 0.50) >= 0 else TURN_DIRECTION_CCW

            write(act_feedrate, feed_act, ua.VariantType.Double)
            write(cmd_feedrate, feed_cmd, ua.VariantType.Double)
            write(act_override, feed_override_val, ua.VariantType.Double)
            write(cmd_override, feed_override_val, ua.VariantType.Double)
            write(dry_run_feed, dry_run, ua.VariantType.Double)
            write(feed_hold, hold, ua.VariantType.Boolean)
            write(act_m, 3 if spindle_act_speed > 100.0 else 5, ua.VariantType.UInt32)
            write(act_program_block, block, ua.VariantType.String)
            write(act_program_line, f"N{line_no*10}", ua.VariantType.String)
            write(act_program_file_offset, file_offset, ua.VariantType.UInt32)
            write(channel_tool_id, tool_id, ua.VariantType.UInt32)
            write(act_program_status, PROGRAM_STATUS_RUNNING, ua.VariantType.Int32)
            write(act_status, CHANNEL_STATUS_ACTIVE, ua.VariantType.Int32)
            write(act_operation_mode, OP_MODE_AUTO if not hold else OP_MODE_MDI, ua.VariantType.Int32)
            write(cmd_operation_mode, OP_MODE_AUTO, ua.VariantType.Int32)

            axis_signals = {
                "x": (
                    x_act,
                    x_cmd,
                    32.0 + 8.0 * math.sin(t * 0.70),
                    1.9 + 0.1 * math.sin(t),
                    8.0 + 0.5 * math.cos(t * 0.8),
                ),
                "y": (
                    y_act,
                    y_cmd,
                    30.0 + 7.0 * math.cos(t * 0.60),
                    1.7 + 0.1 * math.cos(t),
                    7.5 + 0.4 * math.sin(t * 0.9),
                ),
                "z": (
                    z_act,
                    z_cmd,
                    28.0 + 6.0 * math.sin(t * 0.80),
                    1.5 + 0.1 * math.sin(t * 0.5),
                    7.0 + 0.3 * math.cos(t * 1.1),
                ),
            }

            for axis_name, (act_pos, cmd_pos, load, torque, power) in axis_signals.items():
                axis = axis_nodes[axis_name]
                write(axis["ActLoad"], load, ua.VariantType.Double)
                write(axis["ActPower"], power, ua.VariantType.Double)
                write(axis["ActTorque"], torque, ua.VariantType.Double)
                write(axis["CmdTorque"], torque + 0.05, ua.VariantType.Double)
                write(axis["ZeroOffset"], 0.0, ua.VariantType.Double)
                update_position(axis["PosDirect"], act_pos, cmd_pos)
                update_position(axis["PosIndirect"], act_pos + 0.02, cmd_pos + 0.02)

            write(spindle_nodes["ActLoad"], spindle_load, ua.VariantType.Double)
            write(spindle_nodes["ActOverride"], spindle_override, ua.VariantType.Double)
            write(spindle_nodes["ActPower"], spindle_power, ua.VariantType.Double)
            write(spindle_nodes["ActSpeed"], spindle_act_speed, ua.VariantType.Double)
            write(spindle_nodes["ActStatus"], SPINDLE_STATUS_RUNNING, ua.VariantType.Int32)
            write(spindle_nodes["ActTorque"], spindle_act_torque, ua.VariantType.Double)
            write(spindle_nodes["ActTurnDirection"], turn_direction, ua.VariantType.Int32)
            write(spindle_nodes["CmdOverride"], spindle_override, ua.VariantType.Double)
            write(spindle_nodes["CmdSpeed"], spindle_cmd_speed, ua.VariantType.Double)
            write(spindle_nodes["CmdTorque"], spindle_cmd_torque, ua.VariantType.Double)
            update_position(spindle_nodes["AnglePos"], c_act, c_cmd)

            update_position(channel_positions["PosTcpBcsX"], x_act, x_cmd)
            update_position(channel_positions["PosTcpBcsY"], y_act, y_cmd)
            update_position(channel_positions["PosTcpBcsZ"], z_act, z_cmd)
            update_position(channel_positions["PosTcpBcsA"], a_act, a_cmd)
            update_position(channel_positions["PosTcpBcsB"], b_act, b_cmd)
            update_position(channel_positions["PosTcpBcsC"], c_act, c_cmd)

            update_position(channel_positions["PosTcpWcsX"], x_act - 12.5, x_cmd - 12.5)
            update_position(channel_positions["PosTcpWcsY"], y_act + 4.0, y_cmd + 4.0)
            update_position(channel_positions["PosTcpWcsZ"], z_act - 2.0, z_cmd - 2.0)
            update_position(channel_positions["PosTcpWcsA"], a_act, a_cmd)
            update_position(channel_positions["PosTcpWcsB"], b_act, b_cmd)
            update_position(channel_positions["PosTcpWcsC"], c_act, c_cmd)

            time.sleep(1.0)

    print("Server stopped.")


if __name__ == "__main__":
    main()
