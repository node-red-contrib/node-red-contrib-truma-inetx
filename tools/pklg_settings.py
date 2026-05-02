#!/usr/bin/env python3
"""Create a readable settings inventory from a Truma iNet X PacketLogger trace."""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import signal
from collections import OrderedDict
from typing import Any

from pklg_analyze import parse_pklg
from pklg_protocol import CborDecodeError, decode_cbor, find_cbor_offset, iter_att


TYPE_HINTS = {
    1: "integer",
    4: "string",
    9: "object/list",
    12: "object/list",
    15: "level/percent",
    18: "timestamp/duration",
    103: "enum",
    104: "boolean/switch",
    105: "enum/action",
    110: "language/enum",
    114: "state enum",
    117: "state enum",
    119: "timer state",
    202: "error list",
    203: "slot list",
    204: "search result list",
    206: "timer config",
}

SENSITIVE_PARAMETERS = {
    "CertThumb",
    "Muid",
    "SerialNr",
    "UniqueID",
    "UserName",
    "Uuid",
}


def decode_first_cbor(data: bytes) -> Any | None:
    offsets = [18, 16, 0]
    scanned = find_cbor_offset(data)
    if scanned is not None:
        offsets.append(scanned)

    seen = set()
    for offset in offsets:
        if offset in seen or offset >= len(data):
            continue
        seen.add(offset)
        try:
            return decode_cbor(data, offset).value
        except (CborDecodeError, IndexError, struct_error):
            continue
    return None


# struct.error is not a subclass of CborDecodeError, but importing struct just
# for the exception name makes the decode loop noisier than this alias.
try:
    import struct

    struct_error = struct.error
except Exception:  # pragma: no cover
    struct_error = Exception


def extract_frame_length(data: bytes) -> int | None:
    if len(data) < 6:
        return None
    declared = int.from_bytes(data[4:6], "little")
    if declared <= 0:
        return None
    # Observed frame lengths describe the bytes after the first three bytes.
    # Keep this deliberately loose; the decoder is the final arbiter.
    return declared + 3


def iter_reassembled_values(records: list[Any], source_handle: int):
    pending = bytearray()
    pending_records: list[int] = []
    expected_len: int | None = None

    for record, _conn_handle, opcode, att_handle, value in iter_att(records):
        if record.record_type != 0x03 or opcode != 0x1B or att_handle != source_handle:
            continue

        starts_frame = len(value) >= 18 and value[6:8] in (b"\x01\x00", b"\x02\x00", b"\x03\x00")
        if starts_frame:
            if pending:
                yield bytes(pending), pending_records
            pending = bytearray(value)
            pending_records = [record.index]
            expected_len = extract_frame_length(value)
        elif pending:
            pending.extend(value)
            pending_records.append(record.index)
        else:
            pending = bytearray(value)
            pending_records = [record.index]
            expected_len = extract_frame_length(value)

        if pending and expected_len is not None and len(pending) >= expected_len:
            yield bytes(pending), pending_records
            pending = bytearray()
            pending_records = []
            expected_len = None

    if pending:
        yield bytes(pending), pending_records


def normalize_topics(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list) and len(value) >= 2 and isinstance(value[1], dict):
        value = value[1]
    if isinstance(value, dict) and "topics" in value:
        topics = value["topics"]
        if isinstance(topics, list):
            return [topic for topic in topics if isinstance(topic, dict)]
    if isinstance(value, dict) and "tn" in value and "pn" in value:
        return [{"tn": value["tn"], "parameters": [value]}]
    return []


def value_to_text(value: Any, parameter_name: str | None = None, redact: bool = True) -> str:
    if redact and parameter_name in SENSITIVE_PARAMETERS:
        return "<redacted>"
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    if isinstance(value, bytes):
        return "0x" + value.hex()
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        if not value:
            return "[]"
        return "[" + ", ".join(value_to_text(item, redact=redact) for item in value) + "]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        parts = []
        for key, item in value.items():
            parts.append(f"{key}: {value_to_text(item, redact=redact)}")
        return "{" + ", ".join(parts) + "}"
    return str(value)


def table_escape(value: Any) -> str:
    text = value_to_text(value) if not isinstance(value, str) else value
    return text.replace("|", "\\|").replace("\n", " ")


def type_text(value: Any) -> str:
    if value == "":
        return ""
    hint = TYPE_HINTS.get(value)
    if hint:
        return f"{value} ({hint})"
    return str(value)


def collect_settings(records: list[Any]) -> tuple[OrderedDict[str, OrderedDict[str, dict[str, Any]]], list[str]]:
    settings: OrderedDict[str, OrderedDict[str, dict[str, Any]]] = OrderedDict()
    topic_lists: list[str] = []

    for payload, source_records in iter_reassembled_values(records, 0x0027):
        decoded = decode_first_cbor(payload)
        if decoded is None:
            continue

        # Capture plain topic-list responses too; they help explain missing
        # parameter detail in this single trace.
        candidate = decoded[1] if isinstance(decoded, list) and len(decoded) >= 2 else decoded
        if isinstance(candidate, dict) and isinstance(candidate.get("tn"), list):
            topic_lists.extend(str(topic) for topic in candidate["tn"])

        for topic in normalize_topics(decoded):
            topic_name = topic.get("tn", "<unknown>")
            parameters = topic.get("parameters", [])
            if not isinstance(parameters, list):
                continue
            bucket = settings.setdefault(str(topic_name), OrderedDict())
            for parameter in parameters:
                if not isinstance(parameter, dict):
                    continue
                parameter_name = str(parameter.get("pn", "<unknown>"))
                current = bucket.get(parameter_name, {})
                merged = {**current, **parameter}
                merged["source_records"] = ",".join(str(index) for index in source_records)
                bucket[parameter_name] = merged

    return settings, topic_lists


def render_markdown(
    capture_path: pathlib.Path,
    settings: OrderedDict[str, OrderedDict[str, dict[str, Any]]],
    topic_lists: list[str],
    redact: bool,
) -> str:
    lines = [
        "# Truma iNet X Full Connect Settings",
        "",
        f"Source capture: `{capture_path}`",
        f"Generated: `{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}`",
        "",
        "This file is generated from the ignored PacketLogger capture. It lists the settings and parameters that appeared in the full connect/read trace.",
    ]
    if redact:
        lines.append("Sensitive identity-like values are redacted.")
    lines.extend(
        [
            "",
            "## Summary",
            "",
            f"- Topics with decoded parameters: {len(settings)}",
            f"- Decoded parameters: {sum(len(params) for params in settings.values())}",
        ]
    )

    if topic_lists:
        unique_topics = list(OrderedDict((topic, None) for topic in topic_lists).keys())
        lines.extend(["", "## Topic Lists Seen", ""])
        for topic in unique_topics:
            lines.append(f"- {topic}")

    for topic_name, params in settings.items():
        lines.extend(
            [
                "",
                f"## {topic_name}",
                "",
                "| Parameter | Type | Available | Permission | Value | Min | Max | Source records |",
                "| --- | --- | ---: | ---: | --- | ---: | ---: | --- |",
            ]
        )
        for parameter_name, parameter in params.items():
            value = value_to_text(parameter.get("v", ""), parameter_name, redact=redact)
            row = [
                parameter_name,
                type_text(parameter.get("type", "")),
                value_to_text(parameter.get("avail", "")),
                value_to_text(parameter.get("perm", "")),
                value,
                value_to_text(parameter.get("min", "")),
                value_to_text(parameter.get("max", "")),
                str(parameter.get("source_records", "")),
            ]
            lines.append("| " + " | ".join(table_escape(item) for item in row) + " |")

    lines.append("")
    return "\n".join(lines)


def main() -> None:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    parser = argparse.ArgumentParser()
    parser.add_argument("capture", type=pathlib.Path)
    parser.add_argument("--no-redact", action="store_true", help="include identity-like values")
    args = parser.parse_args()

    records = parse_pklg(args.capture)
    settings, topic_lists = collect_settings(records)
    print(render_markdown(args.capture, settings, topic_lists, redact=not args.no_redact))


if __name__ == "__main__":
    main()
