"""Checkpoint 2C golden frames, parser, idempotent database and ACK rules."""

from __future__ import annotations

import json
import struct

import pytest

import config
from services import database
from services.mobile_wire import WireError, ack_serial_line, crc16, decode_mobile, parse_mobile_serial, request_key
from services.mqtt_service import MQTTService
from services.serial_bridge import SerialBridge, classify_serial_line, parse_report_line


KEY = bytes.fromhex("00112233445566778899aabbccddeeff")
USER = bytes.fromhex("0123456789abcdef")
MOBILE_GOLDEN = {
    (1, True): "524e4d3101030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6fb4c2",
    (2, True): "524e4d3102030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6f8258",
    (2, False): "524e4d3102000100112233445566778899aabbccddeeff0123456789abcdef6553f100000000000000000000000000ffff0452696b6f7b18",
}


def frame(kind=2, gps=True, name="Riko", *, event_time=1700000000, fix_time=1699999999):
    encoded_name = name.encode("utf-8")
    flags = (1 | 2) if gps else 0
    body = (b"RNM1" + bytes((kind, flags, 1)) + KEY + USER +
            struct.pack(">IIiiH", event_time, fix_time if gps else 0,
                        -6364821 if gps else 0, 106828913 if gps else 0,
                        68 if gps else 0xFFFF) + bytes((len(encoded_name),)) + encoded_name)
    return body + struct.pack(">H", crc16(body))


@pytest.mark.parametrize("kind,gps", [(1, True), (2, True), (2, False)])
def test_mobile_frames(kind, gps):
    packet = frame(kind, gps)
    assert packet.hex() == MOBILE_GOLDEN[(kind, gps)]
    assert len(packet) <= 100
    decoded = decode_mobile(packet)
    assert decoded["request_key"] == KEY.hex()
    assert decoded["event_type"] == ("SOS" if kind == 2 else "LOCATION")
    assert decoded["has_gps"] is gps
    assert decoded["lat"] == (-6.364821 if gps else None)
    assert decoded["lon"] == (106.828913 if gps else None)
    line = f"RNM1,{KEY.hex()},123,1,{packet.hex()}"
    assert parse_mobile_serial(line)["mesh_hops"] == 1
    assert classify_serial_line(line)[0] == "mobile"


def test_bad_mobile_frames():
    good = frame()
    for malformed in (good[:-1], b"RNM2" + good[4:], good[:4] + b"\x03" + good[5:],
                      good[:-2] + b"\0\0", good[:49] + b"\xff" + good[50:]):
        with pytest.raises(WireError):
            decode_mobile(malformed)
    with pytest.raises(WireError):
        parse_mobile_serial(f"RNM1,{'ff'*16},123,1,{good.hex()}")
    with pytest.raises(WireError):
        decode_mobile(frame(1, False))


def test_request_key_stability():
    assert request_key(b"abc") == "ba7816bf8f01cfea414140de5dae2223"
    assert request_key(b"abc") == request_key(b"abc")
    assert request_key(b"abd") != request_key(b"abc")


def test_legacy_and_ack_compatibility():
    legacy = "-,-,4097,1,0,5,-6.364821,106.828913,1,KRITIS,1,1,SOS"
    assert parse_report_line(legacy)["rssi"] is None
    assert classify_serial_line(legacy)[0] == "report"
    assert ack_serial_line(KEY.hex()) == b"RNACK1,00112233445566778899aabbccddeeff,STORED\n"


def test_legacy_and_ack_binary_golden():
    for pkt, flags, condition, message, golden in (
        (4097, 1, b"SEDANG", b"Riko|Gedung A", "524e4c311001010101ff9ee16b065e1471060d534544414e4752696b6f7c476564756e6720416742"),
        (4098, 3, b"KRITIS", b"SOS", "524e4c311002010301ff9ee16b065e147106034b5249544953534f53726e"),
    ):
        body = b"RNL1" + struct.pack(">HBBBiiBB", pkt, 1, flags, 1, -6364821, 106828913,
                                       len(condition), len(message)) + condition + message
        assert (body + struct.pack(">H", crc16(body))).hex() == golden
        assert len(body) + 2 <= 100
    ack = b"RNA1\x01" + KEY
    assert (ack + struct.pack(">H", crc16(ack))).hex() == "524e41310100112233445566778899aabbccddeeff4e01"


def test_database_duplicate_and_backend_reack(tmp_path):
    path = tmp_path / "events.db"
    database.init_database(path)
    event = decode_mobile(frame())
    event.update(mesh_source=123, mesh_hops=1, rssi=None, snr=None, received_at=1700000001)
    row, inserted = database.insert_mobile_event(event, path)
    assert inserted
    again, inserted = database.insert_mobile_event(event, path)
    assert row == again and not inserted
    assert len(database.query_mobile_events(database_path=path)) == 1
    with pytest.raises(ValueError):
        database.insert_mobile_event({**event, "event_type": "LOCATION"}, path)

    # Exercise backend ACK publication on an existing committed duplicate.
    service = MQTTService(path)
    published = []
    service.client.publish = lambda topic, data, **kwargs: published.append((topic, json.loads(data))) or type("Result", (), {"rc": 0})()
    service._handle_mobile_event(event)
    assert published == [(config.MQTT_MOBILE_ACK_TOPIC, {"request_key": KEY.hex(), "status": "STORED"})]


def test_serial_mqtt_backend_ack_roundtrip(tmp_path):
    path = tmp_path / "roundtrip.db"
    database.init_database(path)
    bridge = SerialBridge(serial_port="COM-test")
    backend = MQTTService(path)
    events = []
    acks = []
    bridge._publish_json = lambda topic, payload, **kwargs: events.append((topic, payload))
    backend.client.publish = lambda topic, data, **kwargs: acks.append((topic, data)) or type("Result", (), {"rc": 0})()
    serial_event = f"RNM1,{KEY.hex()},123,1,{frame().hex()}"
    bridge.handle_line(serial_event)
    assert events[0][0] == config.MQTT_MOBILE_EVENT_TOPIC
    backend._handle_mobile_event(events[0][1])
    assert len(database.query_mobile_events(database_path=path)) == 1
    assert acks[0][0] == config.MQTT_MOBILE_ACK_TOPIC
    message = type("Message", (), {"topic": acks[0][0], "payload": acks[0][1].encode()})()
    bridge._on_mqtt_message(None, None, message)
    assert ack_serial_line(bridge._ack_queue.get_nowait()) == b"RNACK1," + KEY.hex().encode() + b",STORED\n"
