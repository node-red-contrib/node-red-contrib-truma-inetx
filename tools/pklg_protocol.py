#!/usr/bin/env python3
"""Extract higher-level Truma iNet X protocol frames from PacketLogger files."""

from __future__ import annotations

import argparse
import signal
import pathlib
import string
import struct
from dataclasses import dataclass
from typing import Any

from pklg_analyze import Record, parse_pklg


ATT_NAMES = {
    0x01: "error-rsp",
    0x12: "write-req",
    0x13: "write-rsp",
    0x1B: "notify",
    0x52: "write-cmd",
}

ATT_ERRORS = {
    0x01: "Invalid Handle",
    0x02: "Read Not Permitted",
    0x03: "Write Not Permitted",
    0x05: "Insufficient Authentication",
    0x08: "Insufficient Authorization",
    0x0A: "Attribute Not Found",
    0x0F: "Insufficient Encryption",
}


class CborDecodeError(Exception):
    pass


@dataclass
class CborItem:
    value: Any
    next_offset: int


def read_cbor_uint(data: bytes, offset: int, ai: int) -> tuple[int, int]:
    if ai < 24:
        return ai, offset
    if ai == 24:
        return data[offset], offset + 1
    if ai == 25:
        return struct.unpack_from(">H", data, offset)[0], offset + 2
    if ai == 26:
        return struct.unpack_from(">I", data, offset)[0], offset + 4
    if ai == 27:
        return struct.unpack_from(">Q", data, offset)[0], offset + 8
    raise CborDecodeError(f"unsupported additional info {ai}")


def decode_cbor(data: bytes, offset: int = 0) -> CborItem:
    if offset >= len(data):
        raise CborDecodeError("offset past end")
    initial = data[offset]
    offset += 1
    major = initial >> 5
    ai = initial & 0x1F

    if initial == 0xFF:
        return CborItem("<break>", offset)
    if major == 0:
        value, offset = read_cbor_uint(data, offset, ai)
        return CborItem(value, offset)
    if major == 1:
        value, offset = read_cbor_uint(data, offset, ai)
        return CborItem(-1 - value, offset)
    if major in (2, 3):
        if ai == 31:
            chunks = []
            while data[offset] != 0xFF:
                item = decode_cbor(data, offset)
                chunks.append(item.value)
                offset = item.next_offset
            offset += 1
            if major == 2:
                return CborItem(b"".join(chunks), offset)
            return CborItem("".join(chunks), offset)
        length, offset = read_cbor_uint(data, offset, ai)
        raw = data[offset : offset + length]
        offset += length
        if major == 2:
            return CborItem(raw, offset)
        return CborItem(raw.decode("utf-8", errors="replace"), offset)
    if major == 4:
        values = []
        if ai == 31:
            while data[offset] != 0xFF:
                item = decode_cbor(data, offset)
                values.append(item.value)
                offset = item.next_offset
            return CborItem(values, offset + 1)
        length, offset = read_cbor_uint(data, offset, ai)
        for _ in range(length):
            item = decode_cbor(data, offset)
            values.append(item.value)
            offset = item.next_offset
        return CborItem(values, offset)
    if major == 5:
        obj = {}
        pairs = []
        if ai == 31:
            while data[offset] != 0xFF:
                key = decode_cbor(data, offset)
                val = decode_cbor(data, key.next_offset)
                pairs.append((key.value, val.value))
                try:
                    obj[key.value] = val.value
                except TypeError:
                    pass
                offset = val.next_offset
            return CborItem(obj if len(obj) == len(pairs) else pairs, offset + 1)
        length, offset = read_cbor_uint(data, offset, ai)
        for _ in range(length):
            key = decode_cbor(data, offset)
            val = decode_cbor(data, key.next_offset)
            pairs.append((key.value, val.value))
            try:
                obj[key.value] = val.value
            except TypeError:
                pass
            offset = val.next_offset
        return CborItem(obj if len(obj) == len(pairs) else pairs, offset)
    if major == 7:
        if ai == 20:
            return CborItem(False, offset)
        if ai == 21:
            return CborItem(True, offset)
        if ai == 22:
            return CborItem(None, offset)
        if ai == 23:
            return CborItem("<undefined>", offset)
    raise CborDecodeError(f"unsupported CBOR major={major} ai={ai}")


def find_cbor_offset(data: bytes) -> int | None:
    # Truma frames observed so far put the CBOR object after an 18 byte header,
    # but scanning keeps this useful for shorter notifications and future logs.
    for offset, byte in enumerate(data):
        if byte in (0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xBF, 0x81, 0x82, 0x83, 0x84, 0x9F):
            try:
                item = decode_cbor(data, offset)
                if item.next_offset >= len(data) - 1:
                    return offset
            except Exception:
                continue
    return None


def printable_hint(data: bytes) -> str:
    out = []
    current = []
    allowed = set(bytes(string.printable, "ascii"))
    for b in data:
        if b in allowed and b not in b"\r\n\t\x0b\x0c":
            current.append(chr(b))
        else:
            if len(current) >= 4:
                out.append("".join(current))
            current = []
    if len(current) >= 4:
        out.append("".join(current))
    return ", ".join(out[:12])


def format_value(value: Any) -> str:
    if isinstance(value, bytes):
        return "h'" + value.hex() + "'"
    if isinstance(value, dict):
        parts = []
        for key, val in value.items():
            parts.append(f"{key!r}: {format_value(val)}")
        return "{" + ", ".join(parts) + "}"
    if isinstance(value, list):
        return "[" + ", ".join(format_value(v) for v in value) + "]"
    return repr(value)


def iter_att(records: list[Record]):
    for r in records:
        if r.record_type not in (0x02, 0x03) or len(r.payload) < 9:
            continue
        handle_flags, _total_len = struct.unpack_from("<HH", r.payload)
        conn_handle = handle_flags & 0x0FFF
        l2_len, cid = struct.unpack_from("<HH", r.payload, 4)
        if cid != 0x0004:
            continue
        att = r.payload[8 : 8 + l2_len]
        if not att:
            continue
        opcode = att[0]
        att_handle = None
        value = b""
        if opcode == 0x01 and len(att) >= 5:
            att_handle = struct.unpack_from("<H", att, 2)[0]
            value = att[1:5]
        elif opcode in (0x12, 0x52, 0x1B, 0x1D) and len(att) >= 3:
            att_handle = struct.unpack_from("<H", att, 1)[0]
            value = att[3:]
        elif opcode in (0x0A, 0x0C) and len(att) >= 3:
            att_handle = struct.unpack_from("<H", att, 1)[0]
        elif opcode == 0x0B:
            value = att[1:]
        yield r, conn_handle, opcode, att_handle, value


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=pathlib.Path)
    parser.add_argument(
        "--handles",
        default="0x22,0x23,0x25,0x27,0x28,0x2b",
        help="comma-separated ATT handles to show",
    )
    args = parser.parse_args()

    wanted = {int(part, 0) for part in args.handles.split(",") if part}
    records = parse_pklg(args.file)
    print(f"# {args.file}")
    for r, conn_handle, opcode, att_handle, value in iter_att(records):
        if att_handle is not None and att_handle not in wanted:
            continue
        direction = "tx" if r.record_type == 0x02 else "rx"
        opname = ATT_NAMES.get(opcode, f"att-0x{opcode:02x}")
        handle_text = f"0x{att_handle:04x}" if att_handle is not None else "-"
        line = (
            f"#{r.index:05d} {r.timestamp} {direction:<2} conn=0x{conn_handle:04x} "
            f"{opname:<9} handle={handle_text} len={len(value):>3}"
        )
        if value:
            line += f" value={value.hex(' ')}"
            if opcode == 0x01 and len(value) >= 4:
                req_opcode = value[0]
                err = value[3]
                err_name = ATT_ERRORS.get(err, f"0x{err:02x}")
                line += f" error_for=0x{req_opcode:02x} error={err_name}"
            hint = printable_hint(value)
            if hint:
                line += f" text=[{hint}]"
            cbor_offset = find_cbor_offset(value)
            if cbor_offset is not None:
                try:
                    cbor = decode_cbor(value, cbor_offset)
                    line += f" cbor@{cbor_offset}={format_value(cbor.value)}"
                except Exception as exc:
                    line += f" cbor_error={exc}"
        print(line)


if __name__ == "__main__":
    main()
