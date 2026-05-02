#!/usr/bin/env python3
"""Analyze Apple PacketLogger .pklg Bluetooth captures.

The script intentionally emits text summaries only. Raw PacketLogger captures
stay ignored by git and should not be committed.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import pathlib
import struct
from dataclasses import dataclass
from typing import Iterable


PKLG_TYPES = {
    0x00: "hci-cmd",
    0x01: "hci-event",
    0x02: "acl-tx",
    0x03: "acl-rx",
    0x04: "sco-tx",
    0x05: "sco-rx",
    0x06: "log",
    0x07: "new-controller",
    0x08: "deleted-controller",
    0x09: "controller-info",
    0xFC: "note",
}

HCI_EVENTS = {
    0x01: "Inquiry Complete",
    0x03: "Connection Complete",
    0x05: "Disconnection Complete",
    0x07: "Remote Name Request Complete",
    0x0E: "Command Complete",
    0x0F: "Command Status",
    0x13: "Number Of Completed Packets",
    0x3E: "LE Meta",
    0xFF: "Vendor",
}

LE_SUBEVENTS = {
    0x01: "LE Connection Complete",
    0x02: "LE Advertising Report",
    0x03: "LE Connection Update Complete",
    0x04: "LE Read Remote Features Complete",
    0x05: "LE Long Term Key Request",
    0x0A: "LE Enhanced Connection Complete",
    0x0D: "LE Extended Advertising Report",
    0x13: "LE Scan Request Received",
}

ATT_OPCODES = {
    0x01: "Error Response",
    0x02: "Exchange MTU Request",
    0x03: "Exchange MTU Response",
    0x04: "Find Information Request",
    0x05: "Find Information Response",
    0x06: "Find By Type Value Request",
    0x07: "Find By Type Value Response",
    0x08: "Read By Type Request",
    0x09: "Read By Type Response",
    0x0A: "Read Request",
    0x0B: "Read Response",
    0x0C: "Read Blob Request",
    0x0D: "Read Blob Response",
    0x10: "Read By Group Type Request",
    0x11: "Read By Group Type Response",
    0x12: "Write Request",
    0x13: "Write Response",
    0x16: "Prepare Write Request",
    0x17: "Prepare Write Response",
    0x18: "Execute Write Request",
    0x19: "Execute Write Response",
    0x1B: "Handle Value Notification",
    0x1D: "Handle Value Indication",
    0x1E: "Handle Value Confirmation",
    0x52: "Write Command",
}


@dataclass(frozen=True)
class Record:
    index: int
    offset: int
    length: int
    seconds: int
    useconds: int
    record_type: int
    payload: bytes

    @property
    def type_name(self) -> str:
        return PKLG_TYPES.get(self.record_type, f"type-0x{self.record_type:02x}")

    @property
    def timestamp(self) -> str:
        when = dt.datetime.fromtimestamp(self.seconds, tz=dt.timezone.utc)
        return f"{when.isoformat(timespec='seconds')}+{self.useconds:06d}us"


def parse_pklg(path: pathlib.Path) -> list[Record]:
    data = path.read_bytes()
    records: list[Record] = []
    offset = 0
    index = 0
    while offset < len(data):
        if offset + 13 > len(data):
            raise ValueError(f"{path}: truncated record header at offset {offset}")
        length = struct.unpack_from("<I", data, offset)[0]
        if length < 9:
            raise ValueError(f"{path}: invalid record length {length} at offset {offset}")
        end = offset + 4 + length
        if end > len(data):
            raise ValueError(f"{path}: truncated record body at offset {offset}")
        seconds, useconds, record_type = struct.unpack_from("<IIB", data, offset + 4)
        payload = data[offset + 13 : end]
        records.append(Record(index, offset, length, seconds, useconds, record_type, payload))
        offset = end
        index += 1
    return records


def hex_bytes(data: bytes, limit: int | None = None) -> str:
    if limit is not None and len(data) > limit:
        return data[:limit].hex(" ") + f" ...(+{len(data) - limit} bytes)"
    return data.hex(" ")


def reversed_bd_addr(raw: bytes) -> str:
    return ":".join(f"{b:02X}" for b in raw[::-1])


def decode_ad_structures(data: bytes) -> list[tuple[int, bytes]]:
    items = []
    i = 0
    while i < len(data):
        length = data[i]
        i += 1
        if length == 0:
            break
        if i + length > len(data):
            items.append((-1, data[i - 1 :]))
            break
        ad_type = data[i]
        value = data[i + 1 : i + length]
        items.append((ad_type, value))
        i += length
    return items


def ad_summary(data: bytes) -> str:
    parts = []
    for ad_type, value in decode_ad_structures(data):
        if ad_type == -1:
            parts.append(f"malformed={value.hex()}")
        elif ad_type in (0x08, 0x09):
            text = value.decode("utf-8", errors="replace")
            parts.append(f"name={text!r}")
        elif ad_type == 0x0A and value:
            parts.append(f"tx_power={struct.unpack('b', value[:1])[0]}")
        elif ad_type == 0x16 and len(value) >= 2:
            uuid = struct.unpack_from("<H", value)[0]
            parts.append(f"svcdata16=0x{uuid:04x}:{value[2:].hex(' ')}")
        elif ad_type == 0xFF and len(value) >= 2:
            company = struct.unpack_from("<H", value)[0]
            parts.append(f"mfg=0x{company:04x}:{value[2:].hex(' ')}")
        else:
            parts.append(f"ad0x{ad_type:02x}={value.hex(' ')}")
    return ", ".join(parts)


def parse_hci_event(payload: bytes) -> str:
    if len(payload) < 2:
        return f"short-event {payload.hex()}"
    event_code, param_len = payload[0], payload[1]
    params = payload[2:]
    name = HCI_EVENTS.get(event_code, f"event-0x{event_code:02x}")
    if event_code == 0x3E and params:
        subevent = params[0]
        subname = LE_SUBEVENTS.get(subevent, f"LE subevent 0x{subevent:02x}")
        extra = parse_le_meta(subevent, params[1:])
        return f"{name}: {subname}; {extra}"
    if event_code == 0x0E and len(params) >= 3:
        opcode = struct.unpack_from("<H", params, 1)[0]
        return f"{name}: opcode=0x{opcode:04x} status/payload={params[3:].hex(' ')}"
    if event_code == 0x0F and len(params) >= 4:
        status = params[0]
        opcode = struct.unpack_from("<H", params, 2)[0]
        return f"{name}: opcode=0x{opcode:04x} status=0x{status:02x}"
    return f"{name}: len={param_len} params={params.hex(' ')}"


def parse_le_meta(subevent: int, params: bytes) -> str:
    if subevent == 0x0D:
        return parse_le_ext_adv_report(params)
    if subevent == 0x02:
        return parse_le_adv_report(params)
    if subevent in (0x01, 0x0A) and len(params) >= 18:
        status = params[0]
        handle = struct.unpack_from("<H", params, 1)[0] & 0x0FFF
        role = params[3]
        peer_type = params[4]
        peer = reversed_bd_addr(params[5:11])
        return f"status=0x{status:02x} handle=0x{handle:04x} role={role} peer_type={peer_type} peer={peer}"
    return f"params={params.hex(' ')}"


def parse_le_adv_report(params: bytes) -> str:
    if not params:
        return "no reports"
    count = params[0]
    i = 1
    reports = []
    for _ in range(count):
        if i + 9 > len(params):
            break
        event_type = params[i]
        addr_type = params[i + 1]
        addr = reversed_bd_addr(params[i + 2 : i + 8])
        data_len = params[i + 8]
        data = params[i + 9 : i + 9 + data_len]
        rssi_offset = i + 9 + data_len
        rssi = struct.unpack("b", params[rssi_offset : rssi_offset + 1])[0] if rssi_offset < len(params) else None
        reports.append(f"addr={addr} type={addr_type} evt=0x{event_type:02x} rssi={rssi} {ad_summary(data)}")
        i = rssi_offset + 1
    return " | ".join(reports)


def parse_le_ext_adv_report(params: bytes) -> str:
    if not params:
        return "no reports"
    count = params[0]
    i = 1
    reports = []
    for _ in range(count):
        if i + 24 > len(params):
            break
        event_type = struct.unpack_from("<H", params, i)[0]
        addr_type = params[i + 2]
        addr = reversed_bd_addr(params[i + 3 : i + 9])
        rssi = struct.unpack("b", params[i + 12 : i + 13])[0]
        data_len = params[i + 23]
        data = params[i + 24 : i + 24 + data_len]
        reports.append(f"addr={addr} type={addr_type} evt=0x{event_type:04x} rssi={rssi} {ad_summary(data)}")
        i = i + 24 + data_len
    return " | ".join(reports)


def parse_hci_command(payload: bytes) -> str:
    if len(payload) < 3:
        return f"short-command {payload.hex()}"
    opcode = struct.unpack_from("<H", payload)[0]
    plen = payload[2]
    params = payload[3:]
    return f"opcode=0x{opcode:04x} plen={plen} params={params.hex(' ')}"


def parse_acl(payload: bytes) -> str:
    if len(payload) < 8:
        return f"short-acl {payload.hex()}"
    handle_flags, total_len = struct.unpack_from("<HH", payload)
    handle = handle_flags & 0x0FFF
    pb = (handle_flags >> 12) & 0x3
    bc = (handle_flags >> 14) & 0x3
    l2_len, cid = struct.unpack_from("<HH", payload, 4)
    l2_payload = payload[8:]
    base = f"handle=0x{handle:04x} pb={pb} bc={bc} l2cap_len={l2_len} cid=0x{cid:04x}"
    if cid == 0x0004:
        return base + "; ATT " + parse_att(l2_payload)
    if cid == 0x0006:
        return base + "; SMP " + l2_payload.hex(" ")
    return base + "; data=" + l2_payload.hex(" ")


def parse_att(data: bytes) -> str:
    if not data:
        return "empty"
    opcode = data[0]
    name = ATT_OPCODES.get(opcode, f"opcode-0x{opcode:02x}")
    if opcode in (0x0A, 0x0C) and len(data) >= 3:
        return f"{name} handle=0x{struct.unpack_from('<H', data, 1)[0]:04x}"
    if opcode in (0x12, 0x52, 0x16) and len(data) >= 3:
        handle = struct.unpack_from("<H", data, 1)[0]
        return f"{name} handle=0x{handle:04x} value={hex_bytes(data[3:], 80)}"
    if opcode in (0x1B, 0x1D) and len(data) >= 3:
        handle = struct.unpack_from("<H", data, 1)[0]
        return f"{name} handle=0x{handle:04x} value={hex_bytes(data[3:], 80)}"
    if opcode == 0x08 and len(data) >= 7:
        start, end = struct.unpack_from("<HH", data, 1)
        uuid = data[5:]
        return f"{name} start=0x{start:04x} end=0x{end:04x} uuid={uuid.hex(' ')}"
    if opcode == 0x10 and len(data) >= 7:
        start, end = struct.unpack_from("<HH", data, 1)
        uuid = data[5:]
        return f"{name} start=0x{start:04x} end=0x{end:04x} uuid={uuid.hex(' ')}"
    if opcode == 0x02 and len(data) >= 3:
        return f"{name} mtu={struct.unpack_from('<H', data, 1)[0]}"
    if opcode == 0x03 and len(data) >= 3:
        return f"{name} mtu={struct.unpack_from('<H', data, 1)[0]}"
    return f"{name} data={hex_bytes(data[1:], 80)}"


def describe_record(record: Record) -> str:
    if record.record_type == 0x00:
        detail = parse_hci_command(record.payload)
    elif record.record_type == 0x01:
        detail = parse_hci_event(record.payload)
    elif record.record_type in (0x02, 0x03):
        detail = parse_acl(record.payload)
    elif record.record_type == 0xFC:
        detail = record.payload.decode("utf-8", errors="replace")
    else:
        detail = hex_bytes(record.payload, 120)
    return f"#{record.index:05d} {record.timestamp} {record.type_name:<10} {detail}"


def summarize(path: pathlib.Path, records: list[Record]) -> str:
    by_type = collections.Counter(r.type_name for r in records)
    first = records[0].timestamp if records else "n/a"
    last = records[-1].timestamp if records else "n/a"
    lines = [
        f"# {path}",
        f"records: {len(records)}",
        f"bytes: {path.stat().st_size}",
        f"first: {first}",
        f"last: {last}",
        "record types: " + ", ".join(f"{k}={v}" for k, v in sorted(by_type.items())),
    ]
    names = collections.Counter()
    addrs = collections.Counter()
    sample_name_records = []
    for r in records:
        if r.record_type != 0x01 or not r.payload.startswith(b"\x3e"):
            continue
        text = parse_hci_event(r.payload)
        if ("name=" in text or "Truma" in text) and len(sample_name_records) < 12:
            sample_name_records.append(describe_record(r))
        if "addr=" in text:
            for part in text.split("addr=")[1:]:
                addrs[part[:17]] += 1
        if "name='" in text:
            for part in text.split("name='")[1:]:
                names[part.split("'", 1)[0]] += 1
    if names:
        lines.append("advertised names: " + ", ".join(f"{k} ({v})" for k, v in names.most_common()))
    if addrs:
        lines.append("top addresses: " + ", ".join(f"{k} ({v})" for k, v in addrs.most_common(10)))
    if sample_name_records:
        lines.append("sample named advertisements:")
        lines.extend("  " + line for line in sample_name_records)
    return "\n".join(lines)


def digest_record(record: Record) -> tuple[int, bytes]:
    return (record.record_type, record.payload)


def common_prefix(left: list[Record], right: list[Record]) -> int:
    count = 0
    for a, b in zip(left, right):
        if digest_record(a) != digest_record(b):
            break
        count += 1
    return count


def iter_interesting(records: Iterable[Record]) -> Iterable[Record]:
    for r in records:
        if r.record_type in (0x00, 0x02, 0x03, 0xFC):
            yield r
        elif r.record_type == 0x01:
            payload = r.payload
            if payload[:1] != b"\x13":
                yield r


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=pathlib.Path)
    parser.add_argument("--detail", action="store_true", help="print all interesting records")
    parser.add_argument("--diff-prefix", action="store_true", help="print common record prefixes between adjacent files")
    args = parser.parse_args()

    parsed = [(path, parse_pklg(path)) for path in args.files]

    for path, records in parsed:
        print(summarize(path, records))
        if args.detail:
            print()
            for record in iter_interesting(records):
                print(describe_record(record))
        print()

    if args.diff_prefix and len(parsed) > 1:
        print("# Adjacent common prefixes")
        for (left_path, left), (right_path, right) in zip(parsed, parsed[1:]):
            prefix = common_prefix(left, right)
            print(f"{left_path.name} -> {right_path.name}: {prefix} common records")
            for record in right[prefix : prefix + 30]:
                print("  " + describe_record(record))


if __name__ == "__main__":
    main()
