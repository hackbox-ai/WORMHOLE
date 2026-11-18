#!/usr/bin/env python3
"""proto-re —— Deterministic tool layer for protocol reverse engineering。

Four subcommands, each doing one thing, independent of the model：
  extract  From pcap Reorganization TCP Stream (by connection instance, serial number expansion, interval buffering, disk temporary storage）
  segment  Cut the byte stream into messages (length prefix / separator / Original segment）
  hints    Count field candidates (length field, check, entropy, type and state transfer）
  verify   Use Construct Define do parse→build Round trip comparison, byte by byte verification

Design principles: only give facts and candidates, no conclusions; if the data is incomplete, mark it all the way, and never default to completeness。
"""
from __future__ import annotations

import argparse
import json
import os
import time
import math
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

DEFAULT_MAX_MB = 64           # One-way flow upper limit
DEFAULT_TOTAL_MB = 512        # Whole time Total load budget for extract total load budget
MAX_INSTANCES = int(os.environ.get("PROTO_MAX_INSTANCES", "5000"))   # Connection instance upper limit
MAX_OPEN_SPOOLS = 64          # Maximum number of temporary files opened at the same time
GAP_REPORT_LIMIT = 1000       # gap_ranges The upper limit of the list is exceeded and the entire meeting is incomplete.
MAX_SEGMENTS = int(os.environ.get("PROTO_MAX_SEGMENTS", "200000"))  # One-way packet-by-packet offset upper limit
MAX_MESSAGES = int(os.environ.get("PROTO_MAX_MESSAGES", "100000"))  # How many packets can be cut out at most from a single flow?
MAX_ANALYZE_OFFSETS = int(os.environ.get("PROTO_MAX_ANALYZE_OFFSETS", "8192"))   # hints How many bytes can be analyzed at most?
MAX_ANALYZE_SAMPLES = int(os.environ.get("PROTO_MAX_ANALYZE_SAMPLES", "5000"))   # hints How many samples can be used at most?
MAX_SAMPLE_BYTES = int(os.environ.get("PROTO_MAX_SAMPLE_BYTES", str(256 * 1024 * 1024)))


def die(message: str, code: int = 2) -> "NoReturn":
    print(f"proto-re: {message}", file=sys.stderr)
    raise SystemExit(code)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path, what: str) -> Any:
    """The meta information exists but cannot be parsed. An error must be reported - it cannot be quietly treated as ”no problem””。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        die(f"{what} Unable to parse（{path}）：{error}；Confirm that the file is complete or delete it and regenerate it")


def natural_key(value: str) -> list:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", str(value))]


def load_outputs(path: Path) -> tuple[bool, str, str, list[str], list[str]]:
    """Back (Whether to run root, run, owner, File list, Upstream run List)；Compatible with old pure array format。"""
    data = load_json(path, "outputs.json")
    if isinstance(data, list):
        return (False, "", "", [str(item) for item in data], [])
    files = [str(item) for item in (data.get("files") or [])]
    inputs = [str(item) for item in (data.get("inputs") or [])]
    is_root = str(data.get("root") or "") == str(path.parent.resolve())
    return (is_root, str(data.get("run") or ""), str(data.get("owner") or ""), files, inputs)


def new_run_id() -> str:
    return f"{int(time.time() * 1000)}-{os.getpid()}-{os.urandom(3).hex()}"


def write_outputs(root: Path, files: list[str], *, run: str,
                  inputs: tuple[str, ...] = (), owner: str = "") -> None:
    """There are two types of manifests: running root（inputs Record which upstream) and leaf products were read（owner Which output the record belongs to）。"""
    payload: dict[str, Any] = {"run": run, "root": str(root.resolve()), "files": files}
    if owner:
        payload["owner"] = owner
    else:
        payload["inputs"] = [item for item in inputs if item]
    write_json(root / "outputs.json", payload)


def _resolve_manifest(directory: Path) -> tuple[set[Path] | None, list[str]]:
    """Parse the authoritative list of this directory and return (File Collection, used run id)。

    Only**Running root**Authorization file; leaf list (with owner）Just marking, not counting by itself。
    Between running roots, judge the upstream and downstream according to ”who consumed whom”, and take the nearest one：
    Nested output（flows/msgs）Use msgs The root and abandoned leaf directories cannot be read because they are not in the file table of the current root.。
    """
    root = directory.resolve()
    roots: list[tuple[int, str, list[str], set[Path]]] = []
    legacy: set[Path] | None = None
    for base in [root, *root.parents]:
        candidate = base / "outputs.json"
        if not candidate.is_file():
            continue
        is_run_root, run_id, owner, files, inputs = load_outputs(candidate)
        listed = {target for target in ((base / name).resolve() for name in files)
                  if target == root or root in target.parents}
        if is_run_root and not owner and (root == base or base in root.parents):
            roots.append((len(base.parts), run_id, inputs, listed))
        elif legacy is None and not owner:
            legacy = listed
    if not roots:
        return legacy, []
    upstream = {item for entry in roots for item in entry[2]}
    candidates = [entry for entry in roots if entry[1] not in upstream] or roots
    candidates.sort(key=lambda entry: -entry[0])      # The deepest level = The most recent output
    chosen = candidates[0]
    return chosen[3], ([chosen[1]] if chosen[1] else [])


def find_manifest(directory: Path) -> set[Path] | None:
    return _resolve_manifest(directory)[0]


def read_samples(directory: Path, include_incomplete: bool = False) -> tuple[list[tuple[str, bytes]], list[str]]:
    """Read samples in natural order; skip samples marked as incomplete at any level。"""
    root = directory.resolve()
    if not root.exists():
        die(f"Directory does not exist: {directory}")

    # Read quality files on demand: only parse the directory where the samples in the current list are located. quality.json。
    # Bad files in the discard direction should not block this run; bad files that are actually used still report errors.。
    qcache: dict[Path, dict[Path, list[str]]] = {}

    def incomplete_map(directory: Path) -> dict[Path, list[str]]:
        if directory in qcache:
            return qcache[directory]
        mapping: dict[Path, list[str]] = {}
        qpath = directory / "quality.json"
        if qpath.is_file():
            for entry in load_json(qpath, "quality.json"):
                if entry.get("incomplete"):
                    mapping[(directory / entry["file"]).resolve()] = (
                        entry.get("reasons") or ["Marked incomplete"])
        qcache[directory] = mapping
        return mapping

    # If there is a running list, only recognize the list (any level), otherwise it will fall back to rglob
    listed = find_manifest(root)
    if listed is not None:
        entries = [item for item in listed if item.name != "remainder.bin"]
    else:
        entries = [item.resolve() for item in root.rglob("*.bin") if item.name != "remainder.bin"]
    entries.sort(key=lambda item: natural_key(str(item.relative_to(root))))

    samples: list[tuple[str, bytes]] = []
    stats = {"discovered": 0, "missing": 0, "empty": 0, "loaded": 0, "loaded_bytes": 0,
             "skipped_incomplete": 0, "skipped_budget": 0}
    for path in entries:
        stats["discovered"] += 1
        rel = str(path.relative_to(root)) if path != root else path.name
        if not path.is_file() or path.suffix != ".bin":
            stats["missing"] += 1          # It is registered in the list but not on the disk./Not a sample
            continue
        if incomplete_map(path.parent).get(path) and not include_incomplete:
            stats["skipped_incomplete"] += 1
            continue
        size = path.stat().st_size
        if stats["loaded_bytes"] + size > MAX_SAMPLE_BYTES:
            stats["skipped_budget"] += 1
            continue
        data = path.read_bytes()
        if not data:
            stats["empty"] += 1            # Empty samples are not counted as loaded to avoid falsely high denominators.
            continue
        stats["loaded_bytes"] += len(data)
        stats["loaded"] += 1
        samples.append((rel, data))
    if not samples:
        die(f"No samples available: Found {stats['discovered']} Article, incomplete {stats['skipped_incomplete']}，"
            f"Skipped due to budget {stats['skipped_budget']}: {directory}")
    return samples, stats


# ------------------------------------------------------------------ extract

def _ip_text(raw: bytes) -> str:
    import socket
    try:
        return socket.inet_ntop(socket.AF_INET6 if len(raw) == 16 else socket.AF_INET, raw)
    except Exception:
        return raw.hex()


def _l2_length(raw: bytes, linktype: int) -> int:
    """Link layer header length: Ethernet to skip VLAN/QinQ Tags cannot always be pressed 14 Byte calculation。"""
    if linktype == 113:
        return 16
    if linktype == 101:
        return 0
    if linktype != 1 or len(raw) < 14:
        return 14
    offset = 12
    while offset + 4 <= len(raw) and int.from_bytes(raw[offset:offset + 2], 'big') in (0x8100, 0x88a8):
        offset += 4
    return offset + 2


def _iter_packets(pcap_path: Path) -> Iterable[dict[str, Any]]:
    import dpkt
    with open(pcap_path, "rb") as fh:
        head = fh.read(4)
        fh.seek(0)
        reader = dpkt.pcapng.Reader(fh) if head[:4] == b"\x0a\x0d\x0d\x0a" else dpkt.pcap.Reader(fh)
        linktype = reader.datalink()
        captured_short = False
        for ts, raw in reader:
            captured_short = False
            try:
                if linktype == 1:
                    ip = dpkt.ethernet.Ethernet(raw).data
                elif linktype == 101:
                    ip = dpkt.ip.IP(raw)
                elif linktype == 113:
                    ip = dpkt.sll.SLL(raw).data
                else:
                    continue
            except Exception:
                continue
            if not isinstance(ip, (dpkt.ip.IP, dpkt.ip6.IP6)):
                continue
            # Fragmentation: The first piece can be decomposed into TCP，The follow-up film is not. Tools don’t do it IP Reorganization，
            # Therefore, ”this flow may lack a payload” must be marked, and the first fragment cannot be allowed to pretend to be a complete message.。
            fragmented = False
            l2 = _l2_length(raw, linktype)
            if isinstance(ip, dpkt.ip.IP):
                fragmented = bool(ip.off & 0x2000) or (ip.off & 0x1fff) != 0
                # snaplen Truncation: The statement length is greater than the number of bytes captured, indicating that the tail has been cut off
                if ip.len > len(raw) - l2:
                    captured_short = True
            elif isinstance(ip, dpkt.ip6.IP6):
                # IPv6 The declared length must also be checked, otherwise the truncated tail packet will be regarded as the complete payload
                if ip.plen + 40 > len(raw) - l2:
                    captured_short = True
                # IPv6：Fragment The presence of the extension header means unreorganized fragmentation
                for header in getattr(ip, 'extension_hdrs', {}).values():
                    name = type(header).__name__.lower()
                    if 'fragment' in name or getattr(header, 'nxt', None) == 44:
                        fragmented = True
                        break
            tcp = ip.data
            if not isinstance(tcp, dpkt.tcp.TCP):
                continue
            yield {"ts": float(ts), "src": _ip_text(ip.src), "dst": _ip_text(ip.dst),
                   "sport": int(tcp.sport), "dport": int(tcp.dport), "seq": int(tcp.seq),
                   "syn": bool(tcp.flags & dpkt.tcp.TH_SYN), "ack": bool(tcp.flags & dpkt.tcp.TH_ACK),
                   "fin": bool(tcp.flags & dpkt.tcp.TH_FIN), "rst": bool(tcp.flags & dpkt.tcp.TH_RST),
                   "fragmented": fragmented,
                   "snaplen_truncated": captured_short,
                   "data": bytes(tcp.data or b"")}


def _unfold(raw: int, last: int | None) -> int:
    if last is None:
        return raw
    while raw < last - 0x80000000:
        raw += 0x100000000
    while raw > last + 0x80000000:
        raw -= 0x100000000
    return raw


class _Buffer:
    """Interval buffering：bytearray + occupied bits, the memory is about twice the length of the stream。"""

    def __init__(self, limit: int):
        self.limit = limit
        self.buf = bytearray()
        self.seen = bytearray()
        self.conflicts = 0
        self.overlap = 0
        self.dropped = 0            # Bytes falling before the base (normally should be 0）
        self.truncated = False
        self.overflow = 0

    def write(self, offset: int, chunk: bytes) -> None:
        if not chunk:
            return
        if offset < 0:
            # The base number is the earliest serial number after expansion; there is also a negative offset indicating that the previous data is missing
            self.dropped += len(chunk)
            self.truncated = True
            return
        if offset >= self.limit:
            self.truncated = True
            self.overflow += len(chunk)
            return
        if offset + len(chunk) > self.limit:
            self.overflow += offset + len(chunk) - self.limit
            chunk = chunk[: self.limit - offset]
            self.truncated = True
        end = offset + len(chunk)
        if end > len(self.buf):
            grow = end - len(self.buf)
            self.buf.extend(b"\x00" * grow)
            self.seen.extend(b"\x00" * grow)
        for i, byte in enumerate(chunk):
            pos = offset + i
            if self.seen[pos]:
                self.overlap += 1
                if self.buf[pos] != byte:
                    self.conflicts += 1
                continue
            self.buf[pos] = byte
            self.seen[pos] = 1

    def gaps(self, limit: int | None = None) -> tuple[list[list[int]], int]:
        """Back (Interval list, Total number of intervals)；List accepted limit Constrained, the total number is not。"""
        out, pos, size, total = [], 0, len(self.seen), 0
        while pos < size:
            if self.seen[pos]:
                pos += 1
                continue
            start = pos
            while pos < size and not self.seen[pos]:
                pos += 1
            total += 1
            if limit is None or len(out) < limit:
                out.append([start, pos])
        return out, total


class _SpoolSet:
    """Capped scratch writer: no more files open simultaneously than MAX_OPEN_SPOOLS。"""

    def __init__(self, directory: Path):
        self.directory = directory
        self.handles: dict[tuple[int, str], Any] = {}
        self.order: list[tuple[int, str]] = []
        self.closed = False

    def _path(self, inst: int, direction: str) -> Path:
        return self.directory / f"{inst}-{direction}.bin"

    def write(self, inst: int, direction: str, seq: int, data: bytes) -> None:
        key = (inst, direction)
        handle = self.handles.get(key)
        if handle is None:
            if len(self.handles) >= MAX_OPEN_SPOOLS:
                oldest = self.order.pop(0)
                if oldest in self.handles:
                    self.handles.pop(oldest).close()
            handle = open(self._path(inst, direction), "ab")
            self.handles[key] = handle
        if key in self.order:
            self.order.remove(key)
        self.order.append(key)
        handle.write(struct.pack(">QI", seq, len(data)))
        handle.write(data)

    def path(self, inst: int, direction: str) -> Path:
        return self._path(inst, direction)

    def flush(self) -> None:
        for handle in self.handles.values():
            try:
                handle.flush()
            except Exception:
                pass

    def close(self) -> None:
        if self.closed:
            return
        for handle in self.handles.values():
            try:
                handle.close()
            except Exception:
                pass
        self.handles.clear()
        self.order.clear()
        self.closed = True


def _new_instance(instances: list[dict], base: tuple, syn_seq: int | None) -> dict:
    inst = {"index": len(instances), "base": base, "closed": False,
            "syn_seq": syn_seq, "fin": {"a2b": False, "b2a": False}, "rst": False,
            "dirs": {d: {"packets": 0, "bytes": 0, "skipped": 0, "budget_hit": False}
                     for d in ("a2b", "b2a")},
            "boundary_uncertain": False}
    instances.append(inst)
    return inst


def cmd_extract(args: argparse.Namespace) -> int:
    pcap = Path(args.pcap)
    if not pcap.is_file():
        die(f"pcap does not exist: {pcap}")
    out = Path(args.out)
    if out.exists() and any(out.iterdir()) and not args.force:
        die(f"The output directory is not empty: {out}（Confirm to overwrite and add --force；Old files are not automatically deleted）")
    out.mkdir(parents=True, exist_ok=True)

    limit = max(1, args.max_mb) * 1024 * 1024
    total_budget = max(1, args.total_mb) * 1024 * 1024
    # Independent temporary directory for each run: retrying after failure will never read the remnants of the last time
    spool_dir = out / f".spool-{os.getpid()}-{int(time.time() * 1000)}"
    spool_dir.mkdir(parents=True, exist_ok=False)
    spools = _SpoolSet(spool_dir)

    current: dict[tuple, dict] = {}
    instances: list[dict] = []
    budget_exhausted = False
    instances_truncated = False
    manifest: dict[str, Any] = {}
    produced: list[str] = []

    try:
        per_direction: dict[tuple[int, str], int] = defaultdict(int)
        for pkt in _iter_packets(pcap):
            if args.host and args.host not in (pkt["src"], pkt["dst"]):
                continue
            if args.port and args.port not in (pkt["sport"], pkt["dport"]):
                continue
            a = (pkt["src"], pkt["sport"])
            b = (pkt["dst"], pkt["dport"])
            base = (min(a, b), max(a, b))
            direction = "a2b" if a == base[0] else "b2a"
            has_payload = bool(pkt["data"])

            # Pure ACK does not create new instances or change the life cycle
            if not has_payload and not (pkt["syn"] or pkt["fin"] or pkt["rst"]):
                continue

            inst = current.get(base)
            new_syn = pkt["syn"] and not pkt["ack"]
            if new_syn:
                if inst is not None and not inst["closed"] and inst["syn_seq"] == pkt["seq"]:
                    continue                       # SYN Retransmit
                if inst is not None and not inst["closed"]:
                    inst["closed"] = True
                inst = None
            if inst is None or inst["closed"]:
                if len(instances) >= MAX_INSTANCES:
                    # Reaching the upper limit: No more new connections will be added, but existing connections will continue to be processed to avoid interruption of the entire trip.
                    instances_truncated = True
                    continue
                inst = _new_instance(instances, base, pkt["seq"] if new_syn else None)
                inst["boundary_uncertain"] = inst["index"] > 0 and not new_syn
                current[base] = inst

            if pkt["rst"]:
                inst["rst"] = True
                inst["closed"] = True
            if pkt["fin"]:
                inst["fin"][direction] = True
                if all(inst["fin"].values()) or inst["rst"]:
                    inst["closed"] = True
            if not has_payload:
                continue

            key = (inst["index"], direction)
            if per_direction[key] + len(pkt["data"]) > limit:
                inst["dirs"][direction]["budget_hit"] = True
                inst["dirs"][direction]["skipped"] += len(pkt["data"])
                continue
            if budget_exhausted:
                inst["dirs"][direction]["skipped"] += len(pkt["data"])
                continue
            total_written = sum(per_direction.values())
            if total_written + len(pkt["data"]) > total_budget:
                budget_exhausted = True
                inst["dirs"][direction]["skipped"] += len(pkt["data"])
                continue
            per_direction[key] += len(pkt["data"])
            if pkt.get("fragmented"):
                inst["dirs"][direction]["ip_fragmented"] = True
            if pkt.get("snaplen_truncated"):
                inst["dirs"][direction]["snaplen_truncated"] = True
            inst["dirs"][direction]["packets"] += 1
            inst["dirs"][direction]["bytes"] += len(pkt["data"])
            spools.write(inst["index"], direction, pkt["seq"] + (1 if pkt["syn"] else 0), pkt["data"])

        spools.flush()      # To read from the disk for the second time, flush the user state buffer first.

        if not instances:
            die("No parsed TCP Payload; Confirm pcap Format, link layer type and filter conditions")

        manifest = {"pcap": str(pcap), "filter": {"host": args.host, "port": args.port},
                    "limits": {"max_mb_per_direction": args.max_mb, "total_mb": args.total_mb},
                    "budget_exceeded": budget_exhausted, "instances_truncated": instances_truncated,
                    "sessions": []}

        for inst in instances:
            # When scanning for the maximum number of connected connections ends early, there may still be data in the connections that have not yet been closed.
            inst["scan_incomplete"] = instances_truncated and not inst["closed"]
            name = f"flow{inst['index'] + 1:02d}"
            flow_dir = out / name
            flow_dir.mkdir(parents=True, exist_ok=True)
            entry = {"flow": name, "a": f"{inst['base'][0][0]}:{inst['base'][0][1]}",
                     "b": f"{inst['base'][1][0]}:{inst['base'][1][1]}",
                     "boundary_uncertain": inst["boundary_uncertain"],
                     "half_closed": all(inst["fin"].values()), "directions": {}}
            for direction in ("a2b", "b2a"):
                spool = spools.path(inst["index"], direction)
                info = inst["dirs"][direction]
                if not spool.exists() or not info["packets"]:
                    continue
                buffer = _Buffer(limit)

                # First pass: only count the earliest serial number and number of packages after expansion, and do not create any list
                base_seq: int | None = None
                last: int | None = None
                count = 0
                with open(spool, "rb") as fh:
                    while True:
                        header = fh.read(12)
                        if len(header) < 12:
                            break
                        seq, size = struct.unpack(">QI", header)
                        fh.seek(size, 1)
                        unfolded = _unfold(seq, last)
                        last = unfolded
                        base_seq = unfolded if base_seq is None else min(base_seq, unfolded)
                        count += 1
                assert base_seq is not None

                # Second pass: loading; there is an upper limit for segmented records, and details will not be written if it exceeds the limit.
                highest_end = 0
                out_of_order = 0
                keep_segments = count <= MAX_SEGMENTS
                segments: list[dict[str, int]] = []
                with open(spool, "rb") as fh:
                    for _ in range(count):
                        header = fh.read(12)
                        if len(header) < 12:
                            break
                        seq, size = struct.unpack(">QI", header)
                        payload = fh.read(size)
                        unfolded = _unfold(seq, last)
                        last = unfolded
                        offset = unfolded - base_seq
                        if offset < highest_end:
                            out_of_order += 1
                        highest_end = max(highest_end, offset + size)
                        buffer.write(offset, payload)
                        if keep_segments:
                            segments.append({"offset": offset, "len": size})

                gap_ranges, gap_total = buffer.gaps(GAP_REPORT_LIMIT)
                meta = {"bytes": len(buffer.buf), "packets": info["packets"],
                        "gaps": gap_total, "gap_ranges": gap_ranges,
                        "gap_truncated": gap_total > len(gap_ranges),
                        "out_of_order": out_of_order, "retransmits": buffer.overlap,
                        "conflicts": buffer.conflicts,
                        "ip_fragmented": bool(info.get("ip_fragmented")),
                        "snaplen_truncated": bool(info.get("snaplen_truncated")),
                        "truncated": buffer.truncated or inst["scan_incomplete"]
                                     or bool(info.get("ip_fragmented"))
                                     or bool(info.get("snaplen_truncated")),
                        "scan_incomplete": inst["scan_incomplete"],
                        "overflow_bytes": buffer.overflow, "dropped_before_base": buffer.dropped,
                        "budget_skipped_bytes": info["skipped"],
                        "budget_hit": info["budget_hit"] or budget_exhausted}
                with open(flow_dir / f"{direction}.bin", "wb") as fh:
                    fh.write(buffer.buf)
                write_json(flow_dir / f"{direction}.meta.json", meta)
                if keep_segments:
                    segments.sort(key=lambda s: s["offset"])
                    write_json(flow_dir / f"{direction}.segments.json", segments)
                else:
                    write_json(flow_dir / f"{direction}.segments.json",
                               {"truncated": True, "count": count})
                produced.append(f"{name}/{direction}.bin")
                entry["directions"][direction] = {**meta, "file": f"{name}/{direction}.bin"}
            manifest["sessions"].append(entry)
    finally:
        spools.close()
        for leftover in spool_dir.glob("*.bin"):
            leftover.unlink(missing_ok=True)
        try:
            spool_dir.rmdir()
        except OSError:
            pass

    write_json(out / "manifest.json", manifest)
    write_outputs(out, produced, run=new_run_id())
    print(f"Reorganization completed：{len(manifest['sessions'])} connections → {out}")
    if instances_truncated:
        print(f"  Note: The number of connections reached {MAX_INSTANCES}，New connections are skipped (unclosed streams are marked truncated）")
    for entry in manifest["sessions"]:
        prefix = " Uncertain boundaries" if entry["boundary_uncertain"] else ""
        for direction, info in entry["directions"].items():
            flags = []
            if info["gaps"]:
                flags.append(f"Gap {info['gaps']}")
            if info["conflicts"]:
                flags.append(f"Conflict {info['conflicts']}")
            if info["truncated"]:
                flags.append("Truncated")
            if info.get("ip_fragmented"):
                flags.append("Including IP Shards not reorganized")
            if info.get("snaplen_truncated"):
                flags.append("Including snaplen Truncate packet")
            if info["budget_skipped_bytes"]:
                flags.append(f"Budget discard {info['budget_skipped_bytes']}B")
            print(f"  {entry['flow']} {direction}: {info['bytes']} Bytes"
                  + (f"，{'，'.join(flags)}" if flags else "，Complete") + prefix)
    return 0


# ------------------------------------------------------------------ segment

def cmd_segment(args: argparse.Namespace) -> int:
    src = Path(args.dir)
    if not src.exists():
        die(f"Directory does not exist: {src}")
    out = Path(args.out)
    if out.exists() and any(out.iterdir()) and not args.force:
        die(f"The output directory is not empty: {out}（Confirm to overwrite and add --force；Old files are not automatically deleted）")
    out.mkdir(parents=True, exist_ok=True)

    frames: dict[str, Any] = {}
    produced: list[str] = []
    run_id = new_run_id()
    _input_files, input_runs = _resolve_manifest(src)
    # The input side must also follow List of extract : Otherwise --force Running again will destroy the old flow Cut the file again
    # The input terminal uses the list of recent ancestors (including calls from intermediate directories)）
    listed = find_manifest(src)
    for stream_file in sorted(src.rglob("*.bin"), key=lambda p: natural_key(str(p))):
        if ".spool" in stream_file.parts or stream_file.name == "remainder.bin":
            continue
        if listed is not None and stream_file.resolve() not in listed:
            continue
        rel = stream_file.relative_to(src)
        data = stream_file.read_bytes()
        meta_path = stream_file.with_suffix(".meta.json")
        meta = load_json(meta_path, "meta.json") if meta_path.exists() else {}
        gaps = meta.get("gap_ranges") or []
        # Gap list truncated, conflicting, budget exceeded, discarded data: always conservatively mark incomplete

        frame, messages, note, candidates, remainder, cut_truncated = _cut(data, args.frame, stream_file)
        target = out / rel.parent / rel.stem
        target.mkdir(parents=True, exist_ok=True)

        quality = []
        for index, (start, end, payload) in enumerate(messages, start=1):
            name = f"{index:04d}.bin"
            (target / name).write_bytes(payload)
            produced.append(str(Path(rel.parent) / rel.stem / name))
            reasons = []
            for gap_start, gap_end in gaps:
                if start < gap_end and end > gap_start:
                    reasons.append(f"with notch [{gap_start},{gap_end}) Overlap")
                    break
            # The conflict and gap list is truncated: the specific packet cannot be located, and the entire flow can only be marked conservatively
            if meta.get("conflicts"):
                reasons.append("There is a retransmission conflict in the stream and cannot be confirmed one by one.")
            elif meta.get("gap_truncated"):
                reasons.append("The gap list is too long and cannot be confirmed one by one.")
            # Budget/The upper limit causes the tail to be missing: only the one pasted to the end of the stream is incomplete.
            stream_end = int(meta.get("bytes") or 0)
            if meta.get("budget_hit") and end >= stream_end:
                reasons.append("Traffic exceeds budget, tail data is missing")
            # Data older than baseline is discarded: only the first one is affected
            if meta.get("dropped_before_base") and start == 0:
                reasons.append("Beginning data is earlier than baseline and is incomplete")
            if meta.get("ip_fragmented"):
                reasons.append("exists IP Fragmented, not reassembled, the load may be incomplete")
            if meta.get("snaplen_truncated"):
                reasons.append("Packet capture quilt snaplen Truncated, load may be incomplete")
            if meta.get("truncated") and end >= meta.get("bytes", 0):
                reasons.append("Stream truncated, tail data missing")
            quality.append({"file": name, "incomplete": bool(reasons), "reasons": reasons,
                            "start": start, "end": end})
        write_json(target / "quality.json", quality)
        write_outputs(target, [f"{index:04d}.bin" for index in range(1, len(messages) + 1)],
                      run=new_run_id(), owner=run_id)

        if remainder:
            offset, chunk = remainder
            (target / "remainder.bin").write_bytes(chunk)
            produced.append(str(Path(rel.parent) / rel.stem / "remainder.bin"))
            write_json(target / "remainder.json", {"source": str(rel), "offset": offset, "bytes": len(chunk)})

        frames[str(rel)] = {"frame": frame, "messages": len(messages), "note": note,
                            "messages_truncated": cut_truncated,
                            "incomplete": sum(1 for q in quality if q["incomplete"]),
                            "remainder": len(remainder[1]) if remainder else 0,
                            "sizes": sorted({end - start for start, end, _ in messages})[:20],
                            "candidates": candidates}

    write_json(out / "frames.json", frames)
    write_outputs(out, produced, run=run_id, inputs=tuple(input_runs))
    for name, info in frames.items():
        extra = []
        if info["incomplete"]:
            extra.append(f"Among them {info['incomplete']} The item is incomplete")
        if info["remainder"]:
            extra.append(f"Tail left {info['remainder']} Bytes")
        if info["note"]:
            extra.append(info["note"])
        print(f"  {name}: {info['messages']} messages（{info['frame']}）" + ("；" + "；".join(extra) if extra else ""))
    return 0


def _cut(data: bytes, spec: str, stream_file: Path):
    """Back (Frame Mode, [(start,end,bytes)], Description, Other candidates, Residual, Is it truncated due to the upper limit? The delimiter for)。"""
    truncated = False

    if spec.startswith("delim:"):
        raw = spec.split(":", 1)[1]
        sep = bytes.fromhex(raw)
        if not sep:
            die("--frame delim cannot be empty")
        messages, cursor = [], 0
        while True:
            if len(messages) >= MAX_MESSAGES:
                truncated = True
                break
            idx = data.find(sep, cursor)
            if idx < 0:
                break
            if idx > cursor:
                messages.append((cursor, idx, data[cursor:idx]))
            cursor = idx + len(sep)
        remainder = (cursor, data[cursor:]) if cursor < len(data) else None
        note = f"The number of messages exceeds the upper limit {MAX_MESSAGES}，Process only the front {len(messages)} Article" if truncated else ""
        return spec, messages, note, [], remainder, truncated

    if spec.startswith("length:"):
        parts = spec.split(":", 1)[1].split(":")
        if len(parts) < 4:
            die("--frame length Required OFF:SIZE:be|le:MODE[:TRAILER]")
        try:
            offset, size, trailer = int(parts[0]), int(parts[1]), (int(parts[4]) if len(parts) > 4 else 0)
        except ValueError:
            die("--frame length of OFF/SIZE/TRAILER Must be an integer")
        endian, mode = parts[2].lower(), parts[3].lower()
        if offset < 0 or trailer < 0:
            die("--frame length of OFF and TRAILER Cannot be negative")
        if size not in (1, 2, 4):
            die("--frame length of SIZE It can only be The endianness of 1、2、4")
        if endian not in ("be", "le", "big", "little", ">", "<"):
            die("--frame length can only be The mode for be/le")
        if mode not in ("payload", "remaining", "total"):
            die("--frame length can only be payload/remaining/total")
        messages, remainder_at, truncated = _cut_by_length(
            data, offset, size, endian, mode, trailer, MAX_MESSAGES)
        remainder = (remainder_at, data[remainder_at:]) if remainder_at < len(data) else None
        note = f"The number of messages exceeds the upper limit {MAX_MESSAGES}，Process only the front {len(messages)} Article" if truncated else (
            f"Remaining tail {len(remainder[1])} Bytes not parsed" if remainder else "")
        return "length", messages, note, [], remainder, truncated

    if spec == "packet":
        meta_path = stream_file.with_suffix(".segments.json")
        if not meta_path.exists():
            return "packet", [(0, len(data), data)], "Lack of segmentation information, degraded to the entire stream", [], None, False
        segments = load_json(meta_path, "segments.json")
        if isinstance(segments, dict):
            return "packet", [(0, len(data), data)], "Too many segmented records have been truncated and degraded into the entire stream (may contain gaps）", [], None, False
        messages = []
        for seg in segments:
            if len(messages) >= MAX_MESSAGES:
                truncated = True
                break
            start = max(0, seg["offset"])
            end = min(len(data), start + seg["len"])
            if end > start:
                messages.append((start, end, data[start:end]))
        note = f"The number of messages exceeds the upper limit {MAX_MESSAGES}，Process only the front {len(messages)} Article" if truncated else ""
        return "packet", messages, note, [], None, truncated

    candidates = _length_candidates_for_cut(data)
    if candidates:
        best = candidates[0]
        messages, remainder_at, truncated = _cut_by_length(
            data, best["offset"], best["size"], best["endian"], best["mode"], best["trailer"], MAX_MESSAGES)
        remainder = (remainder_at, data[remainder_at:]) if remainder_at < len(data) else None
        note = (f"Length field offset={best['offset']} size={best['size']} {best['endian']} "
                f"{best['mode']} trailer={best['trailer']}；cut into {len(messages)} Article"
                + (f"，Tail left {len(remainder[1])} Bytes" if remainder else "")
                + (f"，Upper limit reached {MAX_MESSAGES}" if truncated else ""))
        return "auto-length", messages, note, candidates[1:6], remainder, truncated
    return "whole", [(0, len(data), data)], "The length prefix is not recognized, treat the entire stream first; it can be specified manually --frame", [], None, False


def _cut_by_length(data: bytes, offset: int, size: int, endian: str, mode: str,
                   trailer: int = 0, limit: int = MAX_MESSAGES):
    """segment; reach limit Stop and return (Message, Stop offset, Is it truncated due to the upper limit? The delimiter for)。"""
    byteorder = "big" if endian in ("be", "big", ">") else "little"
    out: list[tuple[int, int, bytes]] = []
    cursor = 0
    truncated = False
    while cursor + offset + size <= len(data):
        if len(out) >= limit:
            truncated = True
            break
        length = int.from_bytes(data[cursor + offset: cursor + offset + size], byteorder)
        total = length if mode == "total" else offset + size + length + trailer
        if total < offset + size or total <= 0 or cursor + total > len(data):
            break
        out.append((cursor, cursor + total, data[cursor: cursor + total]))
        cursor += total
    return out, cursor, truncated


def _count_cut(data: bytes, offset: int, size: int, endian: str, mode: str,
               trailer: int, limit: int) -> tuple[int, int, bool]:
    """Just count but not create objects for candidate evaluation. Return (Number of items, Stop offset, Whether the upper limit has been reached)。"""
    byteorder = "big" if endian in ("be", "big", ">") else "little"
    cursor, count = 0, 0
    while cursor + offset + size <= len(data):
        if count >= limit:
            return count, cursor, True
        length = int.from_bytes(data[cursor + offset: cursor + offset + size], byteorder)
        total = length if mode == "total" else offset + size + length + trailer
        if total < offset + size or total <= 0 or cursor + total > len(data):
            break
        count += 1
        cursor += total
    return count, cursor, False


def _length_candidates_for_cut(data: bytes) -> list[dict[str, Any]]:
    """Candidates are only retained when ”the entire flow can be cut cleanly”; the evaluation phase only counts and no message objects are created.。"""
    if not data:
        return []
    results = []
    width = min(len(data), 256)
    detect_limit = min(MAX_MESSAGES, 200_000)
    for offset in range(0, min(8, max(0, width - 2)) + 1):
        for size in (1, 2, 4):
            if offset + size > width:
                continue
            for endian in ("big", "little"):
                for mode in ("payload", "remaining", "total"):
                    for trailer in ((0, 2, 4) if mode != "total" else (0,)):
                        count, cursor, hit_limit = _count_cut(data, offset, size, endian, mode, trailer, detect_limit)
                        if count < 2 or cursor != len(data) or hit_limit:
                            continue
                        results.append({"offset": offset, "size": size, "endian": endian,
                                        "mode": mode, "trailer": trailer, "messages": count})
    results.sort(key=lambda r: (r["offset"], r["size"], -r["messages"]))
    return results


# ------------------------------------------------------------------ hints

def cmd_hints(args: argparse.Namespace) -> int:
    samples, stats = read_samples(Path(args.dir), args.include_incomplete)
    lengths = Counter(len(data) for _, data in samples)
    modal_len, modal_count = lengths.most_common(1)[0]
    modal_all = [data for _, data in samples if len(data) == modal_len]
    # There needs to be a budget for byte-by-byte analysis: when the message is very long or there are many samples, only the first paragraph is analyzed and clearly marked.
    group = modal_all[:MAX_ANALYZE_SAMPLES]
    analyze_len = min(modal_len, MAX_ANALYZE_OFFSETS)
    analysis_truncated = analyze_len < modal_len or len(modal_all) > MAX_ANALYZE_SAMPLES

    offsets = []
    for offset in range(analyze_len):
        column = Counter(data[offset] for data in group)
        offsets.append({"offset": offset, "distinct": len(column), "constant": len(column) == 1,
                        "top": [[f"{b:02x}", n] for b, n in column.most_common(3)],
                        "entropy": round(_entropy(column, len(group)), 3),
                        "printable": sum(1 for b in column if 32 <= b < 127) / max(1, len(column))})

    hints = {
        "samples": len(samples), "discovered": stats["discovered"], "loaded": stats["loaded"],
        "skipped_incomplete": stats["skipped_incomplete"], "skipped_budget": stats["skipped_budget"],
        "missing": stats["missing"], "empty": stats["empty"],
        "lengths": {str(k): v for k, v in sorted(lengths.items())},
        "fixed_length": len(lengths) == 1, "modal_length": modal_len, "modal_count": modal_count,
        "analyzed_offsets": analyze_len, "analyzed_samples": len(group),
        "analysis_truncated": analysis_truncated,
        "offsets": offsets,
        "length_candidates": _length_field_candidates([d for _, d in samples]),
        "checksum_candidates": _checksum_candidates(group),
        "high_entropy_regions": _entropy_regions(offsets),
        "types": _type_clusters(samples),
        "transitions": _transitions(samples),
        "notes": ["Length/Verification/Types are only candidates. There may be multiple matches at the same time. They are eliminated by round-trip verification and real interaction.。",
                  "Types are clustered by ”the first distinguishing byte”. That position may also be the sequence number or length. Do not directly regard it as the message type.。"],
    }
    if args.json:
        print(json.dumps(hints, ensure_ascii=False, indent=2))
    else:
        _print_hints(hints)
        write_json(Path(args.out), hints)
        print(f"\nComplete results written {args.out}")
    return 0


def _entropy(column: Counter, total: int) -> float:
    if total <= 1:
        return 0.0
    return -sum((count / total) * math.log2(count / total) for count in column.values())


def _length_field_candidates(group: list[bytes]) -> list[dict[str, Any]]:
    if len(group) < 3:
        return []
    results = []
    width = max(1, min(len(g) for g in group))
    for offset in range(0, min(8, width - 1) + 1):
        for size in (1, 2, 4):
            if offset + size > width:
                continue
            for endian in ("big", "little"):
                for mode in ("payload", "remaining", "total"):
                    for trailer in ((0, 2, 4) if mode != "total" else (0,)):
                        hits = 0
                        for data in group:
                            if offset + size > len(data):
                                continue
                            value = int.from_bytes(data[offset: offset + size],
                                                   "little" if endian == "little" else "big")
                            expected = len(data) if mode == "total" else len(data) - (offset + size) - trailer
                            if value == expected:
                                hits += 1
                        score = hits / len(group)
                        if score >= 0.95:
                            results.append({"offset": offset, "size": size, "endian": endian,
                                            "mode": mode, "trailer": trailer, "score": round(score, 3)})
    results.sort(key=lambda r: (r["offset"], r["size"], r["trailer"]))
    return results


def _checksum_candidates(group: list[bytes]) -> list[dict[str, Any]]:
    import zlib
    if len(group) < 2:
        return []
    results = []
    for size, name in ((4, "crc32"), (2, "crc16-ccitt"), (1, "sum8")):
        for endian in ("big", "little"):
            hits = 0
            for data in group:
                if len(data) <= size:
                    continue
                stored = int.from_bytes(data[-size:], endian)
                if name == "crc32":
                    calc = zlib.crc32(data[:-size]) & 0xFFFFFFFF
                elif name == "crc16-ccitt":
                    calc = _crc16_ccitt(data[:-size])
                else:
                    calc = sum(data[:-size]) & 0xFF
                if calc == stored:
                    hits += 1
            if hits:
                results.append({"algorithm": name, "position": "trailing", "size": size,
                                "endian": endian, "score": round(hits / len(group), 3)})
    return results


def _crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _entropy_regions(offsets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    regions, start = [], None
    for entry in offsets:
        hot = entry["entropy"] >= 6.5 and entry["distinct"] > 32
        if hot and start is None:
            start = entry["offset"]
        elif not hot and start is not None:
            regions.append({"start": start, "end": entry["offset"] - 1})
            start = None
    if start is not None:
        regions.append({"start": start, "end": offsets[-1]["offset"]})
    return [r for r in regions if r["end"] >= r["start"]]


def _type_key(samples: list[tuple[str, bytes]]) -> tuple[int, int]:
    if not samples:
        return 0, 1
    width = min(len(d) for _, d in samples)
    offset = 0
    while offset < width and len({d[offset] for _, d in samples}) == 1:
        offset += 1
    if offset >= width:
        return 0, 1
    one = len({d[offset: offset + 1] for _, d in samples})
    two = len({d[offset: offset + 2] for _, d in samples if len(d) >= offset + 2})
    return offset, (1 if one >= two or offset == width - 1 else 2)


def _type_clusters(samples: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
    offset, size = _type_key(samples)
    counter: Counter = Counter()
    for _, data in samples:
        chunk = data[offset: offset + size]
        if chunk:
            counter[chunk.hex()] += 1
    return [{"offset": offset, "value": value, "count": count} for value, count in counter.most_common(12)]


def _transitions(samples: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
    offset, size = _type_key(samples)
    groups: dict[str, list[tuple[str, bytes]]] = defaultdict(list)
    for rel, data in samples:
        groups[str(Path(rel).parent)].append((rel, data))
    out = []
    for group_name, items in groups.items():
        ordered = sorted(items, key=lambda item: natural_key(Path(item[0]).name))

        def order_of(name: str) -> int:
            digits = re.findall(r"(\d+)", Path(name).stem)
            return int(digits[-1]) if digits else -1

        sequence = [(order_of(rel), data[offset: offset + size].hex()) for rel, data in ordered]
        pairs: Counter = Counter()
        breaks = 0
        for (index_a, type_a), (index_b, type_b) in zip(sequence, sequence[1:]):
            if index_a >= 0 and index_b >= 0 and index_b != index_a + 1:
                breaks += 1          # There are skipped packets in the middle: not generated A→C This false transfer
                continue
            pairs[(type_a, type_b)] += 1
        out.append({"group": group_name, "messages": len(sequence), "breaks": breaks,
                    "transitions": [{"from": a, "to": b, "count": n} for (a, b), n in pairs.most_common(8)]})
    return out


def _print_hints(hints: dict[str, Any]) -> None:
    print(f"Sample {hints['samples']} (Discovered {hints['discovered']}，Incomplete {hints['skipped_incomplete']}，"
          f"Skipped due to budget {hints['skipped_budget']}）；Length distribution {hints['lengths']}")
    if hints.get("analysis_truncated"):
        print(f"Note: Only the first {hints['analyzed_offsets']} bytes、{hints['analyzed_samples']} samples (reached upper limit）")
    if hints["fixed_length"]:
        print(f"Fixed length message：{hints['modal_length']} Bytes")
    const = [o["offset"] for o in hints["offsets"] if o["constant"]]
    if const:
        print(f"Constant byte offset: {const[:32]}{' ...' if len(const) > 32 else ''}")
    if hints["length_candidates"]:
        print("Length field candidate:")
        for c in hints["length_candidates"][:6]:
            print(f"  offset={c['offset']} size={c['size']} {c['endian']} {c['mode']} trailer={c['trailer']} Match rate={c['score']}")
    if hints["checksum_candidates"]:
        print("Verification Candidate:")
        for c in hints["checksum_candidates"][:6]:
            print(f"  {c['algorithm']} Tail {c['size']} Bytes {c['endian']} Match rate={c['score']}")
    if hints["high_entropy_regions"]:
        print(f"High entropy region (possibly compressed/Cipher text/Random number）: {hints['high_entropy_regions'][:6]}")
    if hints["types"]:
        first = hints["types"][0]
        print(f"Type Candidate（offset={first['offset']}，It may also be the serial number/Length）:",
              ", ".join(f"{t['value']}×{t['count']}" for t in hints["types"][:8]))


# ------------------------------------------------------------------ verify

def cmd_verify(args: argparse.Namespace) -> int:
    spec_path = Path(args.spec)
    if not spec_path.is_file():
        die(f"spec does not exist: {spec_path}")
    module = _load_spec(spec_path)
    parse, build = _spec_functions(module)

    samples, stats = read_samples(Path(args.dir), args.include_incomplete)
    passed, failures = 0, []
    for name, data in samples:
        try:
            rebuilt = build(parse(data))
        except Exception as error:
            failures.append({"sample": name, "error": f"{type(error).__name__}: {error}"})
            continue
        if rebuilt == data:
            passed += 1
            continue
        offset = next((i for i, (a, b) in enumerate(zip(data, rebuilt)) if a != b),
                      min(len(data), len(rebuilt)))
        failures.append({"sample": name, "error": "Reconstructed bytes are inconsistent", "offset": offset,
                         "expected_len": len(data), "actual_len": len(rebuilt),
                         "expected_hex": data[max(0, offset - 8): offset + 8].hex(),
                         "actual_hex": rebuilt[max(0, offset - 8): offset + 8].hex()})

    verified = len(samples)
    rate = passed / max(1, verified)
    print(f"Round trip verification：{passed}/{verified} Passed（{rate:.1%}）；Discovery {stats['discovered']} Article，"
          f"Not completely skipped {stats['skipped_incomplete']}，Because the budget has not been verified {stats['skipped_budget']}")
    if stats["skipped_budget"]:
        print("Note: Some samples have not been verified due to the reading budget. This can only be counted as partial verification, which does not mean that all samples passed.。")
    for failure in failures[:10]:
        extra = (f" @offset {failure['offset']} Expectations {failure['expected_hex']} Actual {failure['actual_hex']}"
                 if "offset" in failure else "")
        print(f"  ✗ {failure['sample']}: {failure.get('error')}{extra}")
    print("Tip: Round-trip consistency only proves that the sample can be reconstructed losslessly, but does not prove that field semantics, check recalculation, or new message construction are correct.。")
    if stats["missing"] or stats["empty"]:
        print(f"Note: There are {stats['missing']} items are missing、{stats['empty']} Empty sample, not included in verification。")
    ok = passed == verified and stats["skipped_budget"] == 0 and stats["missing"] == 0 and stats["empty"] == 0
    if args.json:
        write_json(Path(args.json), {"rate": rate, "passed": passed, "verified": verified,
                                     "discovered": stats["discovered"],
                                     "skipped_incomplete": stats["skipped_incomplete"],
                                     "skipped_budget": stats["skipped_budget"],
                                     "missing": stats["missing"], "empty": stats["empty"],
                                     "complete": ok, "failures": failures})
    return 0 if ok else 1


def _load_spec(path: Path) -> Any:
    import importlib.util
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if not spec or not spec.loader:
        die(f"Unable to load spec: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _spec_functions(module: Any):
    if hasattr(module, "parse") and hasattr(module, "build"):
        return module.parse, module.build
    msg = getattr(module, "MSG", None) or getattr(message := module, "message", None)
    if msg is not None and hasattr(msg, "parse") and hasattr(msg, "build"):
        return msg.parse, msg.build
    die("spec Need to provide MSG（Construct object), or parse/build Two functions")


# ------------------------------------------------------------------ main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="proto-re", description="Deterministic tool layer for protocol reverse engineering")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("extract", help="From pcap Reorganization TCP Stream")
    p.add_argument("--pcap", required=True)
    p.add_argument("--host", default="")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--out", required=True)
    p.add_argument("--max-mb", type=int, default=DEFAULT_MAX_MB, help="One-way flow upper limit")
    p.add_argument("--total-mb", type=int, default=DEFAULT_TOTAL_MB, help="This total load budget")
    p.add_argument("--force", action="store_true", help="Allow writing to non-empty output directories (old files are still there, by outputs.json Distinguish）")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("segment", help="Cut byte stream into messages")
    p.add_argument("--dir", required=True)
    p.add_argument("--frame", default="auto",
                   help="auto | packet | length:OFF:SIZE:be|le:payload|remaining|total[:TRAILER] | delim:HEX")
    p.add_argument("--out", required=True)
    p.add_argument("--force", action="store_true", help="Allow writing to non-empty output directories (old files are still there, by outputs.json Distinguish）")
    p.set_defaults(func=cmd_segment)

    p = sub.add_parser("hints", help="Statistics field candidates")
    p.add_argument("--dir", required=True)
    p.add_argument("--json", action="store_true")
    p.add_argument("--out", default="hints.json")
    p.add_argument("--include-incomplete", action="store_true")
    p.set_defaults(func=cmd_hints)

    p = sub.add_parser("verify", help="Construct Define round trip verification")
    p.add_argument("--spec", required=True)
    p.add_argument("--dir", required=True)
    p.add_argument("--json", default="")
    p.add_argument("--include-incomplete", action="store_true")
    p.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
