#!/usr/bin/env python3
"""proto-re Self-test: Synthesize known protocols + Corner cases, four-step link verification and integrity annotation。

Running method：/opt/wormhole-tools/proto-py/bin/python selftest.py
"""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import dpkt

HERE = Path(__file__).resolve().parent
CLI = HERE / "proto_re.py"
PASSED = FAILED = 0


def check(name, ok, detail=""):
    global PASSED, FAILED
    if ok:
        PASSED += 1
    else:
        FAILED += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name:36s} {detail}")


def run(args, expect_ok=True):
    proc = subprocess.run([sys.executable, str(CLI), *map(str, args)], capture_output=True, text=True)
    if expect_ok and proc.returncode != 0:
        print("Command failed:", " ".join(map(str, args)))
        print(proc.stdout[-1200:]); print(proc.stderr[-1200:])
        raise SystemExit(1)
    return proc


# ---------------------------------------------------------------- Protocol and packet capture

def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def msg(mtype: int, seq: int, payload: bytes, flags: int = 0) -> bytes:
    head = struct.pack(">2sBBHH", b"\xa5\x5a", mtype, flags, seq, len(payload)) + payload
    return head + struct.pack(">H", crc16(head))


CLIENT, SERVER = "10.0.0.1", "10.0.0.2"


def packet(seq: int, data: bytes, from_client=True, flags=None) -> bytes:
    if flags is None:
        flags = dpkt.tcp.TH_PUSH | dpkt.tcp.TH_ACK
    tcp = dpkt.tcp.TCP(sport=40000 if from_client else 9000, dport=9000 if from_client else 40000,
                       seq=seq, flags=flags, data=data)
    ip = dpkt.ip.IP(src=socket.inet_aton(CLIENT if from_client else SERVER),
                    dst=socket.inet_aton(SERVER if from_client else CLIENT),
                    p=dpkt.ip.IP_PROTO_TCP, ttl=64, data=tcp)
    ip.len = len(bytes(tcp)) + 20
    eth = dpkt.ethernet.Ethernet(src=b"\x02\x00\x00\x00\x00\x01" if from_client else b"\x02\x00\x00\x00\x00\x02",
                                 dst=b"\x02\x00\x00\x00\x00\x02" if from_client else b"\x02\x00\x00\x00\x00\x01",
                                 type=dpkt.ethernet.ETH_TYPE_IP, data=ip)
    return bytes(eth)


def write_pcap(path: Path, records) -> None:
    with open(path, "wb") as fh:
        writer = dpkt.pcap.Writer(fh, linktype=1)
        for ts, raw in records:
            writer.writepkt(raw, ts=ts)


SPEC = '''
from construct import *

def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc

# The header is defined once: it can be parsed and used in build Reserialize by ”Current Field Value”
HEADER = Struct(
    "magic"   / Const(b"\\xa5\\x5a"),
    "type"    / Int8ub,
    "flags"   / Int8ub,
    "seq"     / Int16ub,
    "length"  / Int16ub,
    "payload" / Bytes(this.length),
)

MSG = Struct(
    "head" / HEADER,
    # parse Time Verification、build Press current head Byte recalculation
    "crc"  / Checksum(Int16ub, crc16, lambda ctx: HEADER.build(ctx.head)),
)
'''


def phase_basic(base: Path) -> None:
    req = [msg(1, 1, b""), msg(2, 2, b"hello world, this is a longer payload"),
           msg(3, 3, bytes(range(32))), msg(2, 4, b"x" * 100), msg(1, 5, b"")]
    resp = [msg(3, 100, b"ok"), msg(2, 101, b"response payload here")]
    req_stream, resp_stream = b"".join(req), b"".join(resp)

    def split(stream, sizes):
        out, cursor = [], 0
        for size in sizes:
            if cursor >= len(stream):
                break
            out.append((cursor, stream[cursor: cursor + size])); cursor += size
        if cursor < len(stream):
            out.append((cursor, stream[cursor:]))
        return out

    req_segs = split(req_stream, [10, 25, 13, 40, 7])
    resp_segs = split(resp_stream, [8, 20])
    ordered = [req_segs[0], req_segs[1], req_segs[3], req_segs[2]] + req_segs[4:]
    ordered = [ordered[0], ordered[1], ordered[1]] + ordered[2:]

    records, ts = [], 1000.0
    for offset, seg in ordered:
        records.append((ts, packet(1000 + offset, seg))); ts += 0.001
    for offset, seg in resp_segs:
        records.append((ts, packet(5000 + offset, seg, from_client=False))); ts += 0.001
    write_pcap(base / "test.pcap", records)

    flows = base / "flows"
    run(["extract", "--pcap", base / "test.pcap", "--port", "9000", "--out", flows])
    manifest = json.loads((flows / "manifest.json").read_text())
    a2b = (flows / "flow01" / "a2b.bin").read_bytes()
    b2a = (flows / "flow01" / "b2a.bin").read_bytes()
    check("The reassembly result is consistent with the original stream",
          (a2b == req_stream and b2a == resp_stream) or (a2b == resp_stream and b2a == req_stream),
          f"a2b={len(a2b)} b2a={len(b2a)}")
    stats = list(manifest["sessions"][0]["directions"].values())
    check("Identify out-of-order and retransmission",
          max((s.get("out_of_order", 0) for s in stats), default=0) >= 1
          and max((s.get("retransmits", 0) for s in stats), default=0) >= 1, "")

    msgs = base / "msgs"
    run(["segment", "--dir", flows, "--frame", "auto", "--out", msgs])
    frames = json.loads((msgs / "frames.json").read_text())
    check("Automatically segment outgoing packets", min(v["messages"] for v in frames.values()) >= 2,
          f"{[v['messages'] for v in frames.values()]}")

    best = max(frames.items(), key=lambda kv: kv[1]["messages"])[0]
    target = msgs / Path(best).parent / Path(best).stem
    hints = json.loads(run(["hints", "--dir", target, "--json"]).stdout)
    lens = hints.get("length_candidates") or []
    check("Identify length field offset=6 2B BE",
          any(c["offset"] == 6 and c["size"] == 2 and c["endian"] == "big" and c["mode"] == "payload" for c in lens), "")
    check("Identification CRC16-CCITT Tail",
          any(c["algorithm"] == "crc16-ccitt" for c in (hints.get("checksum_candidates") or [])), "")
    check("Clustering message type", len(hints.get("types") or []) >= 2, "")

    spec = base / "spec.py"
    spec.write_text(SPEC, encoding="utf-8")
    proc = run(["verify", "--spec", spec, "--dir", target], expect_ok=False)
    check("Construct Round trip byte-by-byte consistency (including CRC Recalculation）", proc.returncode == 0,
          proc.stdout.strip().splitlines()[0] if proc.stdout else "")


def phase_integrity(base: Path) -> None:
    stream = b"".join(msg(2, i, bytes([65 + i]) * 8) for i in range(4))
    segs = [stream[i:i + 10] for i in range(0, len(stream), 10)]
    records, ts, offset = [], 2000.0, 0
    for index, seg in enumerate(segs):
        if index == 1:
            offset += len(seg); continue
        records.append((ts, packet(7000 + offset, seg))); ts += 0.001
        offset += len(seg)
    write_pcap(base / "gap.pcap", records)

    flows = base / "gapflows"
    run(["extract", "--pcap", base / "gap.pcap", "--port", "9000", "--out", flows])
    meta = json.loads((flows / "flow01" / "a2b.meta.json").read_text())
    check("Notch logged", meta["gaps"] >= 1, f"gaps={meta['gaps']}")

    msgs = base / "gapmsgs"
    run(["segment", "--dir", flows, "--frame", "length:6:2:be:payload:2", "--out", msgs])
    quality = json.loads((msgs / "flow01" / "a2b" / "quality.json").read_text())
    check("The affected packets are marked as incomplete.", any(q["incomplete"] for q in quality),
          f"{sum(1 for q in quality if q['incomplete'])}/{len(quality)}")
    hints = json.loads(run(["hints", "--dir", msgs / "flow01" / "a2b", "--json"]).stdout)
    check("hints Skip incomplete samples by default", hints["skipped_incomplete"] >= 1,
          f"Use {hints['samples']} Bar, jump {hints['skipped_incomplete']} Article")

    # When analyzing recursively from the upper directory, it is also necessary to read the subdirectory quality.json
    hints_up = json.loads(run(["hints", "--dir", msgs, "--json"]).stdout)
    check("Recursive analysis still identifies incomplete samples", hints_up["skipped_incomplete"] >= 1,
          f"jump {hints_up['skipped_incomplete']} Article")


def phase_lifecycle(base: Path) -> None:
    records, ts = [], 3000.0
    syn = dpkt.tcp.TH_SYN
    fin = dpkt.tcp.TH_FIN | dpkt.tcp.TH_ACK
    records.append((ts, packet(1000, b"", flags=syn))); ts += 0.001
    records.append((ts, packet(1000, b"", flags=syn))); ts += 0.001          # SYN Retransmit
    records.append((ts, packet(1001, msg(1, 1, b"")))); ts += 0.001
    records.append((ts, packet(1001 + len(msg(1, 1, b"")), b"", flags=fin))); ts += 0.001
    records.append((ts, packet(5000, msg(3, 2, b"reply"), from_client=False))); ts += 0.001  # The peer still sends
    write_pcap(base / "life.pcap", records)

    flows = base / "lifeflows"
    run(["extract", "--pcap", base / "life.pcap", "--port", "9000", "--out", flows])
    manifest = json.loads((flows / "manifest.json").read_text())
    with_data = [s for s in manifest["sessions"] if s["directions"]]
    check("SYN Retransmission and half-close are not split into new connections", len(with_data) == 1, f"Session={len(with_data)}")
    dirs = with_data[0]["directions"] if with_data else {}
    check("The peer data is still in the same stream after half-closing", "b2a" in dirs or "a2b" in dirs and len(dirs) == 2, f"Direction={list(dirs)}")


def phase_late_and_wrap(base: Path) -> None:
    head = msg(1, 1, b"abcdefgh")
    tail = msg(2, 2, b"ijklmnop")
    # Go to the back section first, then to the front section
    records = [(4001.0, packet(1100 + len(tail), tail)), (4000.0, packet(1100, head))]
    write_pcap(base / "late.pcap", records)
    flows = base / "lateflows"
    run(["extract", "--pcap", base / "late.pcap", "--port", "9000", "--out", flows])
    got = (flows / "flow01" / "a2b.bin").read_bytes()
    meta = json.loads((flows / "flow01" / "a2b.meta.json").read_text())
    check("Late front segments are not discarded", got == head + tail and meta["gaps"] == 0,
          f"{len(got)} Bytes gaps={meta['gaps']} dropped={meta['dropped_before_base']}")

    # True cross 2^32：The first segment crosses the boundary and the wrapped segment is received first
    start = 0x100000000 - 10
    first = msg(1, 1, b"12345678901234567890")      # 20 Bytes, across boundary
    second = msg(2, 2, b"after-wrap")
    second_seq = (start + len(first)) % 0x100000000
    records = [(5001.0, packet(second_seq, second)),
               (5000.0, packet(start, first))]
    write_pcap(base / "wrap.pcap", records)
    flows = base / "wrapflows"
    run(["extract", "--pcap", base / "wrap.pcap", "--port", "9000", "--out", flows])
    got = (flows / "flow01" / "a2b.bin").read_bytes()
    meta = json.loads((flows / "flow01" / "a2b.meta.json").read_text())
    check("The serial number is really different 2^32 Still put together in order", got == first + second and meta["gaps"] == 0,
          f"{len(got)} Bytes gaps={meta['gaps']}")


def phase_outputs(base: Path) -> None:
    payload = b"\x00" * 5
    stream_dir = base / "zerostream"; stream_dir.mkdir(parents=True, exist_ok=True)
    (stream_dir / "s.bin").write_bytes(payload)
    out = base / "zeromsgs"
    run(["segment", "--dir", stream_dir, "--frame", "length:0:1:be:payload", "--out", out])
    count = json.loads((out / "frames.json").read_text())[str(Path("s.bin"))]["messages"]
    check("Zero payload frames are not dropped", count == 5, f"Cut out {count} Frame")
    again = run(["segment", "--dir", stream_dir, "--frame", "length:0:1:be:payload", "--out", out],
                expect_ok=False)
    check("Non-empty output directories are rejected by default", again.returncode != 0, "")

    # --force Old samples cannot be mixed in: first 5 Strip, then cut 2 Article
    full = b"".join(msg(1, i, b"") for i in range(5))
    (stream_dir / "t.bin").write_bytes(full)
    out2 = base / "forcetest"
    run(["segment", "--dir", stream_dir, "--frame", "length:6:2:be:payload:2", "--out", out2])
    before = len(list((out2 / "t").glob("*.bin")))
    (stream_dir / "t.bin").write_bytes(full[:len(msg(1, 0, b"")) * 2])
    run(["segment", "--dir", stream_dir, "--frame", "length:6:2:be:payload:2", "--out", out2, "--force"])
    after_files = sorted(p.name for p in (out2 / "t").glob("*.bin"))
    hints = json.loads(run(["hints", "--dir", out2 / "t", "--json"]).stdout)
    check("--force The old samples do not participate in the analysis", hints["samples"] == 2,
          f"In the directory {len(after_files)} files, analyzed {hints['samples']} items (before {before} Article）")

    # remainder.bin
    stream_dir2 = base / "remstream"; stream_dir2.mkdir(parents=True, exist_ok=True)
    (stream_dir2 / "r.bin").write_bytes(msg(1, 1, b"") + msg(1, 2, b"") + b"\xde\xad")
    out3 = base / "remmsgs"
    run(["segment", "--dir", stream_dir2, "--frame", "length:6:2:be:payload:2", "--out", out3])
    rem = out3 / "r" / "remainder.bin"
    check("The tail residue is written as remainder.bin", rem.exists() and rem.read_bytes() == b"\xde\xad",
          f"{rem.stat().st_size if rem.exists() else 0} Bytes")


def phase_conflicts(base: Path) -> None:
    records = [(6000.0, packet(9000, b"AAAA")), (6001.0, packet(9000, b"BBBB"))]
    write_pcap(base / "conflict.pcap", records)
    flows = base / "conflictflows"
    run(["extract", "--pcap", base / "conflict.pcap", "--port", "9000", "--out", flows])
    meta = json.loads((flows / "flow01" / "a2b.meta.json").read_text())
    check("Retransmission conflicts are counted", meta["conflicts"] > 0, f"conflicts={meta['conflicts']}")

    msgs = base / "conflictmsgs"
    run(["segment", "--dir", flows, "--frame", "packet", "--out", msgs])
    quality = json.loads((msgs / "flow01" / "a2b" / "quality.json").read_text())
    check("Conflicting stream integrity is incomplete", all(q["incomplete"] for q in quality),
          f"{sum(1 for q in quality if q['incomplete'])}/{len(quality)}")


def phase_crc(base: Path) -> None:
    """parse Bad should be rejected CRC；After changing the field build Should be recalculated to get the correct CRC。"""
    import importlib.util
    spec_path = base / "spec.py"
    spec = importlib.util.spec_from_file_location("crcspec", spec_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    MSG = module.MSG

    good = msg(2, 7, b"payload")
    bad = good[:-1] + bytes([good[-1] ^ 0xFF])          # Deliberate modification CRC
    try:
        MSG.parse(bad)
        rejected = False
    except Exception:
        rejected = True
    check("Bad CRC in parse Stage rejected", rejected, "")

    obj = MSG.parse(good)
    obj.head.type = 9                              # Change the fields and then build
    rebuilt = MSG.build(obj)
    recomputed = crc16(rebuilt[:-2]) == int.from_bytes(rebuilt[-2:], "big")
    changed = rebuilt[:-2] != good[:-2]
    check("After changing the field build Will recalculate CRC", recomputed and changed,
          f"crc={rebuilt[-2:].hex()} Expectations={crc16(rebuilt[:-2]):04x}")

def phase_relative(base: Path) -> None:
    """Call using relative path in directory（skill This is how the document is written）。"""
    req = b"".join(msg(1, i, b"x") for i in range(3))
    records, ts = [], 7000.0
    for offset, chunk in [(0, req[:4]), (4, req[4:])]:
        records.append((ts, packet(20000 + offset, chunk))); ts += 0.001
    write_pcap(base / "rel.pcap", records)
    run(["extract", "--pcap", base / "rel.pcap", "--port", "9000", "--out", base / "relflows"])
    run(["segment", "--dir", base / "relflows", "--frame", "auto", "--out", base / "relmsgs"])

    proc = subprocess.run([sys.executable, str(CLI), "hints", "--dir", "relmsgs/flow01/a2b", "--json"],
                          capture_output=True, text=True, cwd=str(base))
    ok = proc.returncode == 0
    detail = ""
    if ok:
        try:
            detail = f"samples={json.loads(proc.stdout)['samples']}"
        except Exception:
            ok, detail = False, "The output is not JSON"
    else:
        detail = (proc.stderr or "").strip().splitlines()[-1][:80]
    check("No error is reported when calling relative directory", ok, detail)


def phase_stale_spool(base: Path) -> None:
    """The temporary storage left over from the last failure cannot be reused, otherwise the old and new data will be mixed together.。"""
    req = b"".join(msg(2, i, b"payload") for i in range(3))
    write_pcap(base / "spool.pcap", [(8000.0, packet(30000, req))])
    out = base / "spoolout"

    leftover = out / ".spool-dead-1"
    leftover.mkdir(parents=True, exist_ok=True)
    (leftover / "0-a2b.bin").write_bytes(b"\x00" * 12 + b"GARBAGE" * 4)

    run(["extract", "--pcap", base / "spool.pcap", "--port", "9000", "--out", out, "--force"])
    got = (out / "flow01" / "a2b.bin").read_bytes()
    check("Legacy staging does not pollute new runs", got == req, f"{len(got)} Bytes, expected {len(req)}")
    leftovers = [d.name for d in out.glob(".spool-*") if d.is_dir()]
    check("This temporary storage has been cleared (the old one is not moved）", leftovers == [".spool-dead-1"],
          f"Remaining {leftovers}")


def phase_list_isolation(base: Path) -> None:
    """segment Cut only extract Streams in manifest; intermediate directory analysis only recognizes layer manifest。"""
    req = b"".join(msg(1, i, b"") for i in range(4))
    write_pcap(base / "iso.pcap", [(9000.0, packet(40000, req))])
    flows = base / "isoflows"
    run(["extract", "--pcap", base / "iso.pcap", "--port", "9000", "--out", flows])
    (flows / "flow01" / "zzz.bin").write_bytes(b"STALE" * 10)

    msgs = base / "isomsgs"
    run(["segment", "--dir", flows, "--frame", "auto", "--out", msgs])
    frames = json.loads((msgs / "frames.json").read_text())
    check("segment Ignore unregistered files", all("zzz" not in name for name in frames), f"Processed {list(frames)}")

    stale = msgs / "flow01" / "a2b" / "9999.bin"
    stale.write_bytes(msg(9, 9, b"stale"))
    hints = json.loads(run(["hints", "--dir", msgs / "flow01", "--json"]).stdout)
    check("Intermediate directory read by list", hints["samples"] == 4, f"samples={hints['samples']}（Should not contain 9999.bin）")


def phase_limits(base: Path) -> None:
    """The upper limit of connection must be observable; illegal segmentation parameters must be rejected。"""
    records, ts = [], 10000.0
    for i in range(6):
        seq = 50000 + i * 1000
        records.append((ts, packet(seq, b"", flags=dpkt.tcp.TH_SYN, from_client=True)))
        ts += 0.001
        records.append((ts, packet(seq + 1, msg(1, i, b"abc"))))
        ts += 0.001
    write_pcap(base / "many.pcap", records)

    env = dict(os.environ, PROTO_MAX_INSTANCES="3")
    proc = subprocess.run([sys.executable, str(CLI), "extract", "--pcap", str(base / "many.pcap"),
                           "--port", "9000", "--out", str(base / "manyflows")],
                          capture_output=True, text=True, env=env)
    ok = proc.returncode == 0
    manifest = json.loads((base / "manyflows" / "manifest.json").read_text()) if ok else {}
    check("The connection upper limit can be triggered and will no longer be interrupted", ok and manifest.get("instances_truncated") is True,
          f"Session={len(manifest.get('sessions', []))} truncated={manifest.get('instances_truncated')}")

    stream_dir = base / "badframe"; stream_dir.mkdir(parents=True, exist_ok=True)
    (stream_dir / "x.bin").write_bytes(b"\x01\x02\x03\x04")
    bad = run(["segment", "--dir", stream_dir, "--frame", "length:0:0:be:payload", "--out", base / "badout"],
              expect_ok=False)
    check("Illegal segmentation parameters rejected", bad.returncode != 0, (bad.stderr or "").strip().splitlines()[-1][:60])

def phase_budget(base: Path) -> None:
    """There must be a budget for segmentation and analysis, and clear reporting cutoffs。"""
    payload = b"\x00" * 200                       # 200 indivual 1 Byte zero payload frame
    stream_dir = base / "budgetstream"; stream_dir.mkdir(parents=True, exist_ok=True)
    (stream_dir / "s.bin").write_bytes(payload)

    env = dict(os.environ, PROTO_MAX_MESSAGES="10")
    proc = subprocess.run([sys.executable, str(CLI), "segment", "--dir", str(stream_dir),
                           "--frame", "length:0:1:be:payload", "--out", str(base / "budgetout")],
                          capture_output=True, text=True, env=env)
    frames = json.loads((base / "budgetout" / "frames.json").read_text()) if proc.returncode == 0 else {}
    info = frames.get(str(Path("s.bin")), {})
    check("The upper limit of the number of packets takes effect", info.get("messages") == 10 and info.get("messages_truncated") is True,
          f"messages={info.get('messages')} truncated={info.get('messages_truncated')}")
    rem = base / "budgetout" / "s" / "remainder.bin"
    check("Overrun part completed remainder", rem.exists() and rem.stat().st_size == 190,
          f"{rem.stat().st_size if rem.exists() else 0} Bytes")

    many = base / "manyhints"; many.mkdir(parents=True, exist_ok=True)
    for i in range(3):
        (many / f"{i+1:04d}.bin").write_bytes(bytes(range(64)))
    env2 = dict(os.environ, PROTO_MAX_ANALYZE_OFFSETS="16")
    proc2 = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(many), "--json"],
                           capture_output=True, text=True, env=env2)
    hints = json.loads(proc2.stdout) if proc2.returncode == 0 else {}
    check("There is an upper limit for byte-by-byte analysis", hints.get("analysis_truncated") is True and hints.get("analyzed_offsets") == 16,
          f"analyzed_offsets={hints.get('analyzed_offsets')}")


def phase_manifest_authority(base: Path) -> None:
    """Only recognize the most recent list: discard direction/Old files cannot be brought back from the intermediate directory。"""
    flows = base / "authflows"; (flows / "flow01").mkdir(parents=True, exist_ok=True)
    good = msg(1, 1, b"good")
    (flows / "flow01" / "a2b.bin").write_bytes(good)
    (flows / "flow01" / "b2a.bin").write_bytes(msg(2, 2, b"stale-direction"))
    (flows / "outputs.json").write_text(json.dumps(["flow01/a2b.bin"]))

    out = base / "authmsgs"
    proc = subprocess.run([sys.executable, str(CLI), "segment", "--dir", str(flows / "flow01"),
                           "--frame", "auto", "--out", str(out)], capture_output=True, text=True)
    frames = json.loads((out / "frames.json").read_text()) if proc.returncode == 0 else {}
    check("Intermediate directory filtered by ancestor list", list(frames) == ["a2b.bin"], f"Processed {list(frames)}")

    msgs = base / "authmsgs2"
    for direction, count in (("a2b", 2), ("b2a", 2)):
        d = msgs / "flow01" / direction
        d.mkdir(parents=True, exist_ok=True)
        names = []
        for i in range(1, count + 1):
            name = f"{i:04d}.bin"
            (d / name).write_bytes(msg(1, i, b"x"))
            names.append(name)
        (d / "outputs.json").write_text(json.dumps(names))
    # Root list only authorizes a2b；b2a is leftover from the previous round
    (msgs / "outputs.json").write_text(json.dumps([f"flow01/a2b/{i:04d}.bin" for i in range(1, 3)]))

    hints = json.loads(run(["hints", "--dir", msgs, "--json"]).stdout)
    check("Abandoned directions are no longer counted", hints["samples"] == 2, f"samples={hints['samples']}（Should not contain b2a）")

def phase_manifest_leaf(base: Path) -> None:
    """A direct call to a deprecated leaf directory cannot trust its own old manifest。"""
    msgs = base / "leafmsgs"
    a2b = msgs / "flow01" / "a2b"
    b2a = msgs / "flow01" / "b2a"
    for d in (a2b, b2a):
        d.mkdir(parents=True, exist_ok=True)
    (a2b / "0001.bin").write_bytes(msg(1, 1, b"current"))
    (b2a / "0001.bin").write_bytes(msg(2, 2, b"stale"))
    # Currently running root only authorizes a2b
    proto_helpers = base / "helpers.py"
    (msgs / "outputs.json").write_text(json.dumps(
        {"run": "current", "root": str(msgs.resolve()), "files": ["flow01/a2b/0001.bin"]}))
    # List of legacy formats remaining in leaf directories
    (b2a / "outputs.json").write_text(json.dumps(["0001.bin"]))
    (a2b / "outputs.json").write_text(json.dumps(["0001.bin"]))

    proc = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(b2a), "--json"],
                          capture_output=True, text=True)
    leaked = proc.returncode == 0 and "stale" in (proc.stdout or "")
    check("Deprecated leaf directories are not trusted", proc.returncode != 0 and not leaked,
          (proc.stderr or "").strip().splitlines()[-1][:70] if proc.stderr else f"rc={proc.returncode}")

    proc2 = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(a2b), "--json"],
                           capture_output=True, text=True)
    ok = proc2.returncode == 0 and json.loads(proc2.stdout)["samples"] == 1
    check("The current leaf directory can still be analyzed", ok, f"rc={proc2.returncode}")


def phase_verify_budget(base: Path) -> None:
    """When budget results in non-validation，verify Unable to report all passes。"""
    samples = base / "vsamples"; samples.mkdir(parents=True, exist_ok=True)
    good = msg(1, 1, b"ok")
    (samples / "0001.bin").write_bytes(good)
    (samples / "0002.bin").write_bytes(good)
    spec = base / "vspec.py"
    spec.write_text(SPEC, encoding="utf-8")

    env = dict(os.environ, PROTO_MAX_SAMPLE_BYTES=str(len(good)))   # Only enough for one piece
    out_json = base / "verify.json"
    proc = subprocess.run([sys.executable, str(CLI), "verify", "--spec", str(spec),
                           "--dir", str(samples), "--json", str(out_json)],
                          capture_output=True, text=True, env=env)
    report = json.loads(out_json.read_text()) if out_json.exists() else {}
    check("When the budget is skipped, it is not counted as a full success",
          proc.returncode != 0 and report.get("skipped_budget") == 1 and report.get("complete") is False,
          f"rc={proc.returncode} skipped_budget={report.get('skipped_budget')} complete={report.get('complete')}")
    check("Success/Part of it can be written json", out_json.exists(), f"{out_json.name}")

def phase_nested_output(base: Path) -> None:
    """The output directory is embedded in the input directory（flows/msgs）：Cannot be overridden by the upper original flow list。"""
    req = b"".join(msg(1, i, b"payload") for i in range(3))
    write_pcap(base / "nested.pcap", [(12000.0, packet(60000, req))])
    flows = base / "nflows"
    run(["extract", "--pcap", base / "nested.pcap", "--port", "9000", "--out", flows])

    nested = flows / "msgs"
    proc = subprocess.run([sys.executable, str(CLI), "segment", "--dir", str(flows),
                           "--frame", "auto", "--out", str(nested)],
                          capture_output=True, text=True)
    ok_seg = proc.returncode == 0
    hints = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(nested), "--json"],
                           capture_output=True, text=True)
    ok_read = hints.returncode == 0
    count = json.loads(hints.stdout)["samples"] if ok_read else 0
    check("Nested output is still readable", ok_seg and ok_read and count == 3,
          f"segment={proc.returncode} hints={hints.returncode} samples={count}")

    leaf = nested / "flow01" / "a2b"
    hints2 = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(leaf), "--json"],
                            capture_output=True, text=True)
    count2 = json.loads(hints2.stdout)["samples"] if hints2.returncode == 0 else 0
    check("Nested leaf directories are still readable", hints2.returncode == 0 and count2 == 3, f"samples={count2}")

    # Create a new independent output directory in the old running directory (no upstream and downstream relationships), you should use your own list
    independent = flows / "extra"
    independent.mkdir(parents=True, exist_ok=True)
    (independent / "0001.bin").write_bytes(msg(1, 1, b"independent"))
    (independent / "outputs.json").write_text(json.dumps(
        {"run": "indep-1", "root": str(independent.resolve()), "inputs": [],
         "files": ["0001.bin"]}))
    hints3 = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(independent), "--json"],
                            capture_output=True, text=True)
    count3 = json.loads(hints3.stdout)["samples"] if hints3.returncode == 0 else 0
    check("Independent output directory uses its own list", hints3.returncode == 0 and count3 == 1, f"samples={count3}")

def phase_real_two_pass(base: Path) -> None:
    """True twice segment：Only one direction is left for the second time, the old direction leaf directory cannot be read again。"""
    req = b"".join(msg(1, i, b"req") for i in range(2))
    resp = b"".join(msg(2, i, b"resp") for i in range(2))
    records = [(16000.0, packet(70000, req)),
               (16001.0, packet(80000, resp, from_client=False))]
    write_pcap(base / "twopass.pcap", records)

    flows = base / "tpflows"
    run(["extract", "--pcap", base / "twopass.pcap", "--port", "9000", "--out", flows])
    manifest = json.loads((flows / "manifest.json").read_text())
    dirs = list(manifest["sessions"][0]["directions"])
    check("Test data contains bidirectional", len(dirs) == 2, f"Direction={dirs}")

    msgs = base / "tpmsgs"
    run(["segment", "--dir", flows, "--frame", "auto", "--out", msgs])
    first = json.loads((msgs / "frames.json").read_text())
    check("First cut out of both directions", len(first) == 2, f"{list(first)}")

    # Simulate second time extract --force Output only a2b：Rewrite input list, only authorize a2b Stream
    (flows / "outputs.json").write_text(json.dumps(
        {"run": "second-input", "root": str(flows.resolve()), "inputs": [], "files": ["flow01/a2b.bin"]}))
    run(["segment", "--dir", flows, "--frame", "auto", "--out", msgs, "--force"])
    second = json.loads((msgs / "frames.json").read_text())
    check("Only cut in one direction for the second time", list(second) == ["flow01/a2b.bin"], f"{list(second)}")

    root_read = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(msgs), "--json"],
                               capture_output=True, text=True)
    root_count = json.loads(root_read.stdout)["samples"] if root_read.returncode == 0 else 0
    check("Reading from root contains only current direction", root_read.returncode == 0 and root_count == 2, f"samples={root_count}")

    stale_leaf = msgs / "flow01" / "b2a"
    stale_read = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(stale_leaf), "--json"],
                                capture_output=True, text=True)
    check("Deprecated leaf directories are not re-read", stale_read.returncode != 0,
          (stale_read.stderr or "").strip().splitlines()[-1][:60] if stale_read.stderr else f"rc={stale_read.returncode}")

    live_leaf = msgs / "flow01" / "a2b"
    live_read = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(live_leaf), "--json"],
                               capture_output=True, text=True)
    live_count = json.loads(live_read.stdout)["samples"] if live_read.returncode == 0 else 0
    check("Current direction leaf directory is readable", live_read.returncode == 0 and live_count == 2, f"samples={live_count}")

def phase_fragments(base: Path) -> None:
    """IP Fragments must be marked, the first fragment cannot be regarded as a complete message。"""
    payload = msg(1, 1, b"x" * 120)
    tcp = dpkt.tcp.TCP(sport=50000, dport=9000, seq=100, flags=dpkt.tcp.TH_PUSH | dpkt.tcp.TH_ACK,
                       data=payload)
    first, second = payload[:80], payload[80:]
    tcp_first = dpkt.tcp.TCP(sport=50000, dport=9000, seq=100,
                             flags=dpkt.tcp.TH_PUSH | dpkt.tcp.TH_ACK, data=first)
    ip1 = dpkt.ip.IP(src=socket.inet_aton('10.1.0.1'), dst=socket.inet_aton('10.1.0.2'),
                     p=dpkt.ip.IP_PROTO_TCP, ttl=64, id=4242, data=tcp_first)
    ip1.mf = 1                      # more fragments
    ip1.len = len(bytes(ip1))
    ip2 = dpkt.ip.IP(src=socket.inet_aton('10.1.0.1'), dst=socket.inet_aton('10.1.0.2'),
                     p=dpkt.ip.IP_PROTO_TCP, ttl=64, id=4242, data=second)
    ip2.offset = (20 + len(first)) // 8   # with 8 Bytes in units
    ip2.len = len(bytes(ip2))
    eth = lambda ip: dpkt.ethernet.Ethernet(src=b'\x02\x00\x00\x00\x00\x01',
                                            dst=b'\x02\x00\x00\x00\x00\x02',
                                            type=dpkt.ethernet.ETH_TYPE_IP, data=ip)
    write_pcap(base / "frag.pcap", [(3000.0, bytes(eth(ip1))), (3000.1, bytes(eth(ip2)))])

    flows = base / "fragflows"
    run(["extract", "--pcap", base / "frag.pcap", "--port", "9000", "--out", flows])
    manifest = json.loads((flows / "manifest.json").read_text())
    direction = next(iter(manifest["sessions"][0]["directions"].values()))
    check("IP Shard marked", direction.get("ip_fragmented") is True and direction.get("truncated") is True,
          f"fragmented={direction.get('ip_fragmented')}")

    msgs = base / "fragmsgs"
    run(["segment", "--dir", flows, "--frame", "auto", "--out", msgs])
    quality = json.loads((msgs / "flow01" / "a2b" / "quality.json").read_text())
    reasons = " ".join(quality[0]["reasons"] if quality else [])
    check("Fragmented sample marked as incomplete", bool(quality) and quality[0]["incomplete"] and "Sharding" in reasons, reasons[:40])


def phase_stale_quality(base: Path) -> None:
    """Damaged in the discard direction quality.json Should not block current run。"""
    msgs = base / "staleq"
    live = msgs / "flow01" / "a2b"
    dead = msgs / "flow01" / "b2a"
    live.mkdir(parents=True, exist_ok=True)
    dead.mkdir(parents=True, exist_ok=True)
    (live / "0001.bin").write_bytes(msg(1, 1, b"live"))
    (dead / "0001.bin").write_bytes(msg(2, 2, b"dead"))
    (live / "quality.json").write_text(json.dumps([{"file": "0001.bin", "incomplete": False, "reasons": []}]))
    (dead / "quality.json").write_text("{ This is not JSON")
    (msgs / "outputs.json").write_text(json.dumps(
        {"run": "cur", "root": str(msgs.resolve()), "inputs": [], "files": ["flow01/a2b/0001.bin"]}))

    proc = subprocess.run([sys.executable, str(CLI), "hints", "--dir", str(msgs), "--json"],
                          capture_output=True, text=True)
    ok = proc.returncode == 0 and json.loads(proc.stdout or '{"samples":0}')["samples"] == 1
    check("Discard bad quality files without blocking", ok,
          (proc.stderr or "").strip().splitlines()[-1][:60] if proc.returncode else "samples ok")

def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        phase_basic(base)
        phase_integrity(base)
        phase_lifecycle(base)
        phase_late_and_wrap(base)
        phase_outputs(base)
        phase_conflicts(base)
        phase_crc(base)
        phase_relative(base)
        phase_stale_spool(base)
        phase_list_isolation(base)
        phase_limits(base)
        phase_budget(base)
        phase_manifest_authority(base)
        phase_manifest_leaf(base)
        phase_verify_budget(base)
        phase_nested_output(base)
        phase_real_two_pass(base)
        phase_fragments(base)
        phase_stale_quality(base)
    print(f"\nResult: {PASSED} Passed / {FAILED} Failure")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
