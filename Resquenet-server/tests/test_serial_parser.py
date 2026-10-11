"""Unit tests for the T-Beam Gateway serial contract."""

import pytest

from services.serial_bridge import (
    ReportValidationError,
    classify_serial_line,
    parse_report_line,
)


VALID = "-72,8.4,4097,1,1,3,-6.2001,106.8167,1,KRITIS,3,1,Butuh bantuan segera"


def test_valid_packet_is_typed_and_timestamped():
    report = parse_report_line(VALID, received_at=1_700_000_000.0)
    assert report == {
        "rssi": -72,
        "snr": 8.4,
        "pkt_id": 4097,
        "src_id": 1,
        "hop": 1,
        "max_hop": 3,
        "lat": -6.2001,
        "lon": 106.8167,
        "has_gps": 1,
        "kondisi": "KRITIS",
        "jumlah": 3,
        "sos": 1,
        "pesan": "Butuh bantuan segera",
        "received_at": 1_700_000_000.0,
    }


def test_message_containing_commas_is_preserved():
    line = "-72,8.4,4097,1,1,3,-6.2001,106.8167,1,KRITIS,3,1,Butuh bantuan, korban terjebak, akses sulit"
    report = parse_report_line(line)
    assert report["pesan"] == "Butuh bantuan, korban terjebak, akses sulit"


@pytest.mark.parametrize("line", ["hello world", "1,2,3", "", ",,,,,"])
def test_malformed_packet_is_rejected(line):
    with pytest.raises(ReportValidationError):
        parse_report_line(line)


def test_gateway_ready_is_not_a_report():
    kind, payload = classify_serial_line("GATEWAY_READY\r\n")
    assert kind == "ready"
    assert payload == "GATEWAY_READY"


def test_rnh1_heartbeat_is_typed_and_not_a_report():
    kind, heartbeat = classify_serial_line("\x1b[32mRNH1,2,9068,1,123,3,4\x1b[0m\r\n", received_at=1234.5)
    assert kind == "heartbeat"
    assert heartbeat == {
        "node_id": 2, "mesh_source": 9068, "mesh_hops": 1,
        "uptime_seconds": 123, "mesh_synced": True, "gateway_found": True,
        "pending_count": 4, "received_at": 1234.5,
    }


@pytest.mark.parametrize("line", ["RNH1,0,9068,1,123,3,4", "RNH1,2,0,1,123,3,4", "RNH1,2,9068,1,0,3,4", "RNH1,2,9068,1,123,4,4"])
def test_invalid_heartbeat_envelope_is_rejected(line):
    kind, _payload = classify_serial_line(line)
    assert kind == "invalid"


def test_drop_log_is_not_a_report():
    kind, _payload = classify_serial_line("[DROP] Format paket tidak valid.")
    assert kind == "drop"


def test_firmware_information_is_not_a_report():
    kind, _payload = classify_serial_line("OLED terdeteksi.")
    assert kind == "firmware"


def test_coloured_loramesher_log_is_not_a_malformed_report():
    kind, payload = classify_serial_line(
        "\x1b[36m[DEBUG] [0x2510] Already Sleeping\x1b[0m\r\n"
    )
    assert kind == "firmware"
    assert payload == "[DEBUG] [0x2510] Already Sleeping"


def test_mesh_failure_log_is_not_gateway_ready():
    # Only the explicit GATEWAY_READY token (or actual forwarded data) can mark
    # the mesh firmware ready; a PMU/start error is diagnostic only.
    from services.serial_bridge import SerialBridge

    bridge = SerialBridge(serial_port="COM-test")
    bridge.publish_gateway_status = lambda: None
    bridge.handle_line("[MESH] PMU failure")
    assert bridge.gateway_ready is False
    bridge.handle_line("GATEWAY_READY")
    assert bridge.gateway_ready is True


def test_unknown_line_is_invalid_without_raising():
    kind, detail = classify_serial_line("hello world")
    assert kind == "invalid"
    assert "expected 13 fields" in detail


def test_invalid_packet_id_is_rejected():
    with pytest.raises(ReportValidationError, match="pkt_id"):
        parse_report_line(VALID.replace("4097,1,1", "0,1,1"))


@pytest.mark.parametrize("max_hop", ["-1", "21"])
def test_invalid_max_hop_is_rejected(max_hop):
    fields = VALID.split(",", 12)
    fields[5] = max_hop
    with pytest.raises(ReportValidationError, match="max_hop"):
        parse_report_line(",".join(fields))


@pytest.mark.parametrize(
    ("lat", "lon"),
    [("-91", "106.8"), ("91", "106.8"), ("-6.2", "181"), ("-6.2", "-181")],
)
def test_invalid_gps_is_rejected(lat, lon):
    fields = VALID.split(",", 12)
    fields[6], fields[7] = lat, lon
    with pytest.raises(ReportValidationError):
        parse_report_line(",".join(fields))


def test_missing_gps_does_not_claim_coordinate_validity():
    fields = VALID.split(",", 12)
    fields[6], fields[7], fields[8] = "0", "0", "0"
    report = parse_report_line(",".join(fields))
    assert report["has_gps"] == 0

