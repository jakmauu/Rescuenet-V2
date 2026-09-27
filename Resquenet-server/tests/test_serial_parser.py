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


def test_drop_log_is_not_a_report():
    kind, _payload = classify_serial_line("[DROP] Format paket tidak valid.")
    assert kind == "drop"


def test_firmware_information_is_not_a_report():
    kind, _payload = classify_serial_line("OLED terdeteksi.")
    assert kind == "firmware"


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

