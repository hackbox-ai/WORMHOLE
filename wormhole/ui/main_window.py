"""Wormhole desktop shell — run dashboard & embedded browser (viewer mode).

Layout:
  - Left: target URL / goal anchors + browser control + surface stats
  - Center top: built-in browser (QWebEngineView)
  - Center bottom: proxy traffic table (from the followed run dir)
  - Right: attack surface DAG (layered layout, clickable nodes)
  - Bottom: event log

Viewer mode: the window follows the latest run directory under ``wormhole_runs/``
and renders whatever data the run has produced (``.state/proxy_flows.db`` traffic,
``.state/surface.db`` attack-surface graph). No engine is driven from here.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication, QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
    QMainWindow, QPlainTextEdit, QPushButton, QScrollArea, QSplitter,
    QTabWidget, QTableWidget, QTableWidgetItem, QTextEdit, QVBoxLayout, QWidget,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage

logger = logging.getLogger(__name__)


class _NoNavPage(QWebEnginePage):
    """A QWebEnginePage that REFUSES all navigation away from its initial HTML.

    The attack-surface graph (graph_view) renders a Canvas DAG. It must NEVER
    navigate to an http(s) URL — a stray click or external CDP client could
    otherwise make the target site render inside the graph panel.

    This page overrides acceptNavigationRequest to block every navigation that
    is NOT the initial setHtml. The graph only ever shows our setHtml Canvas
    DAG; it must never load a real page.
    """

    def __init__(self, parent=None):
        super().__init__(parent)

    def acceptNavigationRequest(self, url, nav_type, is_main):  # noqa: ARG002
        # ALLOW our own setHtml content. setHtml() delivers the page as a
        # data: URL (or about:blank), and Qt reports it as NavigationTypeTyped
        # in the real GUI (not NavigationTypeOther as in offscreen tests). So
        # we must key the allow-list off the URL scheme, not the nav_type.
        scheme = url.scheme().lower()
        if scheme in ("data", "about", ""):
            return True
        # BLOCK every http/https/file navigation — the graph is locked to the
        # DAG render and must never load a real page.
        logger.info("graph_view blocked navigation to %s (%s) — graph is locked to DAG render",
                    url.toString()[:80], scheme)
        return False


# ============================================================================
# DB helpers
# ============================================================================

_LLM_HOSTS = {"api.deepseek.com", "api.openai.com", "api.anthropic.com"}


def _latest_run_dir() -> Path | None:
    runs = Path("wormhole_runs")
    if not runs.exists():
        return None
    dirs = sorted(runs.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for d in dirs:
        if d.name.startswith("scan-") and (d / ".state").is_dir():
            return d
    for d in dirs:
        if (d / ".state").is_dir():
            return d
    return None


def _read_proxy_flows(run_dir: Path, limit: int = 100) -> list[dict[str, Any]]:
    db = run_dir / ".state" / "proxy_flows.db"
    if not db.exists():
        return []
    try:
        # mode=ro with WAL: read-only connections still see WAL-committed rows.
        # busy_timeout avoids "database is locked" if the recorder is mid-commit.
        conn = sqlite3.connect(f"file:{db}?mode=ro&busy_timeout=3000", uri=True)
        rows = conn.execute(
            "SELECT id, method, host, path, response_status, roundtrip_ms, category "
            "FROM flows ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        # Filter out LLM API traffic — only show real browser/target traffic
        return [{"id": r[0], "method": r[1], "host": r[2], "path": r[3], "status": r[4],
                 "rt": r[5], "cat": r[6]} for r in rows if r[2] not in _LLM_HOSTS]
    except sqlite3.Error:
        return []


def _read_flow_detail(run_dir: Path, flow_id: str) -> dict[str, Any] | None:
    db = run_dir / ".state" / "proxy_flows.db"
    if not db.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = conn.execute(
            "SELECT method, scheme, host, port, path, query, is_tls, "
            "request_headers, request_body, response_status, response_reason, "
            "response_headers, response_body, roundtrip_ms "
            "FROM flows WHERE id = ?", (flow_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return {
            "method": row[0], "scheme": row[1], "host": row[2], "port": row[3],
            "path": row[4], "query": row[5], "is_tls": row[6],
            "request_headers": row[7], "request_body": row[8],
            "response_status": row[9], "response_reason": row[10],
            "response_headers": row[11], "response_body": row[12],
        }
    except sqlite3.Error:
        return None


def _format_http(detail: dict[str, Any], part: str) -> str:
    if part == "request":
        qs = f"?{detail['query']}" if detail.get("query") else ""
        lines = [f"{detail['method']} {detail['path']}{qs} HTTP/1.1",
                 f"Host: {detail['host']}"]
        try:
            for k, v in json.loads(detail.get("request_headers") or "{}").items():
                lines.append(f"{k}: {v}")
        except (json.JSONDecodeError, TypeError):
            pass
        lines.append("")
        body = detail.get("request_body")
        if body:
            raw = body.decode("utf-8", "replace")[:50000] if isinstance(body, bytes) else str(body)[:50000]
            if "json" in str(detail.get("request_headers", "")).lower():
                try:
                    raw = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
                except (json.JSONDecodeError, TypeError):
                    pass
            lines.append(raw)
        return "\n".join(lines)
    else:
        status = detail.get("response_status", 0)
        lines = [f"HTTP/1.1 {status} {detail.get('response_reason', '')}"]
        try:
            for k, v in json.loads(detail.get("response_headers") or "{}").items():
                lines.append(f"{k}: {v}")
        except (json.JSONDecodeError, TypeError):
            pass
        lines.append("")
        body = detail.get("response_body")
        if body:
            raw = body.decode("utf-8", "replace")[:50000] if isinstance(body, bytes) else str(body)[:50000]
            try:
                hdrs = json.loads(detail.get("response_headers") or "{}")
                if "json" in str(hdrs.get("content-type", hdrs.get("Content-Type", ""))).lower():
                    raw = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
            except (json.JSONDecodeError, TypeError):
                pass
            lines.append(raw)
        return "\n".join(lines)


def _read_surface_nodes(run_dir: Path) -> list[dict[str, Any]]:
    db = run_dir / ".state" / "surface.db"
    if not db.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        nodes = []
        for nid, ntype, data_json in conn.execute("SELECT id, type, data FROM nodes"):
            try:
                d = json.loads(data_json)
            except (json.JSONDecodeError, TypeError):
                d = {}
            nodes.append({"id": nid, "type": ntype, "data": d})
        conn.close()
        return nodes
    except sqlite3.Error:
        return []


def _read_surface_edges(run_dir: Path) -> list[dict[str, str]]:
    db = run_dir / ".state" / "surface.db"
    if not db.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        edges = [{"src": s, "dst": dt, "relation": rel} for s, dt, rel in
                 conn.execute("SELECT DISTINCT src, dst, relation FROM edges WHERE src != dst").fetchall()]
        conn.close()
        return edges
    except sqlite3.Error:
        return []


def _render_dag_html(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, str]],
    origin: str = "",
    goal: str = "",
) -> str:
    """Fixed DAG layout — origin (target site) at top, goal at bottom, facts flowing down.

    The graph forms an origin → facts → goal loop. Two virtual anchor nodes
    are injected:
      - ``__origin__`` (teal, layer 0): the initial target site the user entered.
      - ``__goal__``  (rose, bottom layer): the user's goal description.
    When at least one ``finding`` exists, a dashed rose edge closes the loop
    (last finding → goal), making the closure visually explicit. Before any
    finding, the goal stays an open amber placeholder.
    """
    # Build node/edge JSON for dagre
    node_colors = {
        "origin": "#2dd4bf", "goal": "#f43f5e", "finding": "#da3633",
        "app": "#1f6feb", "endpoint": "#238636", "parameter": "#d29922",
        "function": "#8957e5", "intent": "#bc8cff",
        "scope": "#6e7681", "source": "#768390",
    }

    # ---- Inject virtual origin & goal anchor nodes ----
    virt_nodes: list[dict[str, Any]] = []
    findings = [n for n in nodes if n.get("type") == "finding"]
    has_finding = len(findings) > 0
    if origin:
        virt_nodes.append({
            "id": "__origin__", "type": "origin",
            "data": {"url": origin, "name": "起始站点", "description": "用户输入的攻击起点"},
        })
    if goal:
        # Build a detailed goal description: status + list of findings achieved.
        if has_finding:
            finding_lines = []
            for f in findings:
                d = f.get("data", {})
                finding_lines.append(
                    f"  • [{str(d.get('severity', '?')).upper()}] {d.get('vuln_type', '?')}"
                    f" — {str(d.get('poc', ''))[:70]}"
                )
            goal_desc = goal + "\n\n✅ 已完成 — 发现漏洞:\n" + "\n".join(finding_lines)
            goal_name = "🎯 目标已达成 ✓"
        else:
            goal_desc = goal + "\n\n⏳ 进行中 — 尚未发现漏洞"
            goal_name = "🎯 渗透目标"
        virt_nodes.append({
            "id": "__goal__", "type": "goal",
            "data": {"name": goal_name, "description": goal_desc,
                     "status": "achieved" if has_finding else "open"},
        })
    all_nodes = virt_nodes + nodes

    if not all_nodes:
        return """<body style='margin:0;background:#0d1117;display:flex;align-items:center;
        justify-content:center;height:100vh;font-family:sans-serif;color:#586069;font-size:14px'>
        🕸️ 等待攻击面图数据...</body>"""

    cy_nodes = []
    for n in all_nodes:
        d = n.get("data", {})
        label = (d.get("url") or d.get("name") or d.get("vuln_type") or
                 d.get("description", "")[:30] or n["id"])
        label = str(label)[:35]
        cy_nodes.append({
            "id": n["id"], "label": label, "type": n.get("type", "fact"),
            "color": node_colors.get(n.get("type", ""), "#6366f1"),
            "data": json.dumps(d, ensure_ascii=False)[:500],
        })
    cy_edges = [{"source": e["src"], "target": e["dst"]} for e in edges]

    # ---- origin → app/endpoint edges (origin seeds the graph) ----
    app_node_ids = [n["id"] for n in nodes if n.get("type") == "app"]
    if not app_node_ids:
        # fall back to first endpoint if no app node yet
        app_node_ids = [n["id"] for n in nodes if n.get("type") == "endpoint"][:1]
    for aid in app_node_ids:
        cy_edges.append({"source": "__origin__", "target": aid, "kind": "seed"})

    # ---- findings → goal edges (close the loop) ----
    finding_ids = [n["id"] for n in nodes if n.get("type") == "finding"]
    for fid in finding_ids:
        cy_edges.append({"source": fid, "target": "__goal__", "kind": "closes"})

    nodes_js = json.dumps(cy_nodes, ensure_ascii=False)
    edges_js = json.dumps(cy_edges, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ background:#0d1117; overflow:hidden; font-family:-apple-system,sans-serif; }}
#cy {{ width:100%; height:100vh; }}
#detail {{
  position:fixed; top:8px; right:8px; width:320px; max-height:80vh;
  background:#161b22; border:1px solid #30363d; border-radius:8px;
  padding:12px; display:none; overflow-y:auto; z-index:100;
  box-shadow:0 4px 12px rgba(0,0,0,0.4);
}}
#detail h3 {{ color:#58a6ff; font-size:13px; margin-bottom:8px; }}
#detail .row {{ margin-bottom:6px; }}
#detail .label {{ color:#768390; font-size:10px; text-transform:uppercase; }}
#detail .value {{ color:#c9d1d9; font-size:12px; word-break:break-all; }}
#info {{ position:fixed; bottom:4px; left:8px; color:#484f58; font-size:10px; }}
</style></head><body>
<div id="cy"></div>
<div id="detail"></div>
<div id="info"></div>
<script>
const NODES = {nodes_js};
const EDGES = {edges_js};
const COLORS = {json.dumps(node_colors)};
const container = document.getElementById('cy');
// Minimal dagre-like layout: assign layers based on edge topology
const inDeg = {{}}, outDeg = {{}};
NODES.forEach(n => {{ inDeg[n.id]=0; outDeg[n.id]=0; }});
EDGES.forEach(e => {{ if(inDeg[e.target]!==undefined) inDeg[e.target]++; if(outDeg[e.source]!==undefined) outDeg[e.source]++; }});
// Simple topological layering
const layer = {{}};
const visited = new Set();
function assignLayer(id, l) {{
  if (visited.has(id)) return;
  visited.add(id);
  layer[id] = Math.max(layer[id]||0, l);
  EDGES.filter(e=>e.source===id).forEach(e => assignLayer(e.target, l+1));
}}
NODES.filter(n => inDeg[n.id]===0).forEach(n => assignLayer(n.id, 0));
NODES.forEach(n => {{ if(!visited.has(n.id)) layer[n.id]=0; }});
const maxLayer = Math.max(...Object.values(layer), 0);
// Position: each layer is a row, nodes spread horizontally
const layerNodes = {{}};
NODES.forEach(n => {{
  const l = layer[n.id];
  if(!layerNodes[l]) layerNodes[l]=[];
  layerNodes[l].push(n);
}});
const W = window.innerWidth - 40;
const H = window.innerHeight - 40;
const rowH = Math.min(120, (H-40) / Math.max(maxLayer+1, 1));
NODES.forEach(n => {{
  const l = layer[n.id];
  const peers = layerNodes[l] || [n];
  const idx = peers.indexOf(n);
  n.x = 20 + (W / Math.max(peers.length,1)) * (idx + 0.5);
  n.y = 20 + l * rowH + rowH/2;
}});

const canvas = document.createElement('canvas');
canvas.width = window.innerWidth; canvas.height = window.innerHeight;
container.appendChild(canvas);
const ctx = canvas.getContext('2d');
let selectedNode = null;

function draw() {{
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // Edges — seed (origin→graph) solid teal, closes (finding→goal) dashed rose
  EDGES.forEach(e => {{
    const s = NODES.find(n=>n.id===e.source), t = NODES.find(n=>n.id===e.target);
    if(!s||!t) return;
    const sx=s.x, sy=s.y+18, tx=t.x, ty=t.y-18;
    ctx.beginPath();
    if(e.kind === 'closes') {{
      ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 2.5; ctx.setLineDash([6,4]);
    }} else if(e.kind === 'seed') {{
      ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2; ctx.setLineDash([]);
    }} else {{
      ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    }}
    ctx.moveTo(sx, sy);
    const my = (sy+ty)/2;
    ctx.bezierCurveTo(sx, my, tx, my, tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    // Arrow
    const ang = Math.atan2(ty-my, tx-tx);  // simplified
    ctx.beginPath();
    ctx.moveTo(tx, ty); ctx.lineTo(tx-6, ty-4); ctx.lineTo(tx-6, ty+4);
    ctx.closePath(); ctx.fillStyle=ctx.strokeStyle; ctx.fill();
  }});
  // Nodes — origin & goal are larger rounded-rect anchors
  NODES.forEach(n => {{
    const isSel = selectedNode && selectedNode.id === n.id;
    const isAnchor = n.id === '__origin__' || n.id === '__goal__';
    if(isAnchor) {{
      const w = 120, h = 40;
      if(isSel) {{ ctx.shadowColor=n.color; ctx.shadowBlur=24; }}
      ctx.fillStyle = n.color;
      ctx.beginPath();
      const rx=n.x-w/2, ry=n.y-h/2, rad=10;
      ctx.moveTo(rx+rad,ry); ctx.arcTo(rx+w,ry,rx+w,ry+h,rad);
      ctx.arcTo(rx+w,ry+h,rx,ry+h,rad); ctx.arcTo(rx,ry+h,rx,ry,rad);
      ctx.arcTo(rx,ry,rx+w,ry,rad); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = isSel ? '#fff' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = isSel ? 3 : 1.5; ctx.stroke();
      // Anchor label (white, centered)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign='center';
      const lbl = n.id==='__origin__' ? '🌐 ORIGIN' : (n.data && n.data.includes('achieved') ? '🎯 GOAL ✓' : '🎯 GOAL');
      ctx.fillText(lbl, n.x, n.y+4);
      // sub-label below
      ctx.fillStyle = '#c9d1d9'; ctx.font = '9px sans-serif';
      const sub = n.label.length>22 ? n.label.slice(0,20)+'…' : n.label;
      ctx.fillText(sub, n.x, n.y+h/2+12);
    }} else {{
      const r = 18;
      if(isSel) {{ ctx.shadowColor=n.color; ctx.shadowBlur=20; }}
      ctx.fillStyle = n.color;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2*Math.PI); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = isSel ? '#fff' : '#30363d';
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.stroke();
      // Type badge
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(n.type.slice(0,4).toUpperCase(), n.x, n.y+3);
      // Label below
      ctx.fillStyle = '#c9d1d9'; ctx.font = '10px sans-serif';
      const lbl = n.label.length>20 ? n.label.slice(0,18)+'…' : n.label;
      ctx.fillText(lbl, n.x, n.y+r+14);
    }}
  }});
  // Loop-closure badge: count closes edges
  const closedCount = EDGES.filter(e=>e.kind==='closes').length;
  document.getElementById('info').textContent =
    NODES.length + ' nodes · ' + EDGES.length + ' edges · ' +
    (closedCount > 0 ? '闭环 ✓×' + closedCount : '闭环未达成');
}}

canvas.addEventListener('click', e => {{
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let hit = null;
  for(const n of NODES) {{
    if(n.id === '__origin__' || n.id === '__goal__') {{
      // anchor: 120x40 rounded rect
      if(Math.abs(mx-n.x) < 60 && Math.abs(my-n.y) < 20) {{ hit = n; break; }}
    }} else {{
      const dx = mx-n.x, dy = my-n.y;
      if(Math.sqrt(dx*dx+dy*dy) < 22) {{ hit = n; break; }}
    }}
  }}
  if(hit) {{
    selectedNode = hit;
    const detail = document.getElementById('detail');
    let html = '<h3>' + hit.type.toUpperCase() + '</h3>';
    html += '<div class="row"><div class="label">ID</div><div class="value">' + hit.id + '</div></div>';
    html += '<div class="row"><div class="label">Label</div><div class="value">' + hit.label + '</div></div>';
    try {{
      const d = JSON.parse(hit.data);
      for(const [k,v] of Object.entries(d)) {{
        const val = typeof v === 'object' ? JSON.stringify(v,null,2) : String(v);
        html += '<div class="row"><div class="label">' + k + '</div><div class="value">' +
          val.slice(0,200).replace(/</g,'&lt;') + '</div></div>';
      }}
    }} catch(e) {{ html += '<div class="value">'+hit.data+'</div>'; }}
    detail.innerHTML = html;
    detail.style.display = 'block';
    draw();
  }} else {{
    selectedNode = null;
    document.getElementById('detail').style.display = 'none';
    draw();
  }}
}});

window.addEventListener('resize', () => {{
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  draw();
}});

draw();
</script></body></html>"""


# ============================================================================
# Main window
# ============================================================================

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("虫洞 Wormhole — 运行看板")
        self.resize(1600, 1000)
        self._cached_flows: list[dict[str, Any]] = []
        self._last_graph_sig: str = ""
        self._current_run_dir: Path | None = None  # followed run dir (auto-follows the latest)
        self._build_ui()
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._refresh)
        # 500ms poll: keeps the traffic table visually live as new run data
        # lands, and picks up newly created run dirs quickly.
        self._poll_timer.start(500)

    def _build_ui(self) -> None:
        # GitHub Dark theme — unified palette across ALL widgets.
        #   bg deep:  #0d1117   bg panel: #161b22   border: #30363d
        #   fg:       #c9d1d9   fg dim:  #8b949e    accent blue: #1f6feb
        #   green:    #238636   red:     #da3633
        self.setStyleSheet("""
            QMainWindow, QWidget { background: #0d1117; color: #c9d1d9; font-size: 12px; }
            QSplitter::handle { background: #30363d; }
            QSplitter::handle:horizontal { width: 2px; }
            QSplitter::handle:vertical { height: 2px; }
            QScrollArea { background: #0d1117; border: none; }
            QScrollArea > QWidget > QWidget { background: #0d1117; }
            QScrollBar:vertical { background: #0d1117; width: 10px; border: none; }
            QScrollBar::handle:vertical { background: #30363d; border-radius: 5px; min-height: 30px; }
            QScrollBar::handle:vertical:hover { background: #484f58; }
            QScrollBar::add-line, QScrollBar::sub-line { height: 0; }
            QScrollBar::horizontal { background: #0d1117; height: 10px; border: none; }
            QScrollBar::handle:horizontal { background: #30363d; border-radius: 5px; min-width: 30px; }
            QScrollBar::handle:horizontal:hover { background: #484f58; }
            QLabel { color: #c9d1d9; font-size: 12px; background: transparent; }
            QGroupBox { color: #58a6ff; font-weight: bold; border: 1px solid #30363d;
                        border-radius: 8px; margin-top: 14px; padding-top: 14px;
                        background: #0d1117; font-size: 12px; }
            QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 6px; background: #0d1117; }
            QLineEdit, QTextEdit, QPlainTextEdit {
                background: #161b22; color: #c9d1d9; border: 1px solid #30363d;
                border-radius: 6px; padding: 6px; font-size: 12px; selection-background-color: #1f6feb;
            }
            QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus { border-color: #1f6feb; }
            QPlainTextEdit { font-family: 'Consolas','Cascadia Code',monospace; }
            QPushButton {
                background: #238636; color: #fff; border: none; border-radius: 6px;
                padding: 8px 16px; font-size: 12px; font-weight: bold;
            }
            QPushButton:hover { background: #2ea043; }
            QPushButton:disabled { background: #21262d; color: #484f58; }
            QTableWidget { background: #0d1117; color: #c9d1d9; gridline-color: #21262d;
                           font-size: 11px; border: 1px solid #30363d; border-radius: 4px; alternate-background-color: #161b22; }
            QTableWidget::item { padding: 3px 8px; border: none; }
            QTableWidget::item:selected { background: #1f6feb; color: #fff; }
            QHeaderView::section { background: #161b22; color: #8b949e; border: none;
                                   border-right: 1px solid #21262d; padding: 6px 8px; font-size: 11px; font-weight: bold; }
            QHeaderView { background: #161b22; border: none; }
            QTabWidget::pane { border: 1px solid #30363d; background: #0d1117; border-radius: 4px; }
            QTabBar { background: transparent; }
            QTabBar::tab { background: #161b22; color: #8b949e; padding: 8px 16px;
                           border: 1px solid #30363d; border-bottom: none;
                           border-top-left-radius: 6px; border-top-right-radius: 6px; margin-right: 2px; }
            QTabBar::tab:selected { background: #1f6feb; color: #fff; }
            QTabBar::tab:hover:!selected { background: #21262d; color: #c9d1d9; }
            QCheckBox { color: #c9d1d9; spacing: 6px; }
            QCheckBox::indicator { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #30363d; background: #161b22; }
            QCheckBox::indicator:checked { background: #1f6feb; border-color: #1f6feb; }
            QToolTip { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; padding: 4px; }
        """)

        # === LEFT: anchors + browser control ===
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setSpacing(8)

        # Goal / origin anchors (rendered in the DAG as __origin__ / __goal__)
        goal_box = QGroupBox("🎯 目标 (Goal)")
        goal_layout = QVBoxLayout(goal_box)
        self.target_input = QLineEdit("http://localhost:8080/")
        goal_layout.addWidget(QLabel("站点 URL（图谱起点 / 浏览器地址）:"))
        goal_layout.addWidget(self.target_input)
        self.goal_edit = QTextEdit()
        self.goal_edit.setPlaceholderText("渗透目标描述（图谱终点锚点）...\n例: 发现目标站点的所有 SQL注入、XSS、CRLF 等漏洞")
        self.goal_edit.setMaximumHeight(60)
        goal_layout.addWidget(self.goal_edit)
        ll.addWidget(goal_box)

        # Browser control
        ctrl_box = QGroupBox("🌐 浏览器")
        ctrl_layout = QVBoxLayout(ctrl_box)
        self.browser_btn = QPushButton("🌐 打开浏览器")
        self.browser_btn.setStyleSheet("background:#1f6feb;")
        self.browser_btn.clicked.connect(self._on_open_browser)
        ctrl_layout.addWidget(self.browser_btn)
        ll.addWidget(ctrl_box)

        # Surface stats
        stat_box = QGroupBox("📊 攻击面统计")
        stat_layout = QVBoxLayout(stat_box)
        self.stat_label = QLabel("等待运行数据...")
        self.stat_label.setStyleSheet("font-family: monospace; font-size: 11px; color: #8b949e;")
        stat_layout.addWidget(self.stat_label)
        ll.addWidget(stat_box)

        # Business understanding list (function nodes = explored business functions)
        biz_box = QGroupBox("🧭 业务理解列表（AI 探索记录）")
        biz_layout = QVBoxLayout(biz_box)
        self.biz_list = QTableWidget(0, 2)
        self.biz_list.setHorizontalHeaderLabels(["业务功能", "调用端点"])
        self.biz_list.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.biz_list.verticalHeader().setVisible(False)
        self.biz_list.setMaximumHeight(140)
        self.biz_list.setStyleSheet("QTableWidget { background: #0d1117; color: #c9d1d9; font-size: 11px; }")
        biz_layout.addWidget(self.biz_list)
        ll.addWidget(biz_box)

        ll.addStretch(1)
        # Wrap left panel in a scroll area so it stays a fixed left column.
        left_scroll = QScrollArea()
        left_scroll.setWidget(left)
        left_scroll.setWidgetResizable(True)
        left_scroll.setFixedWidth(300)

        # === CENTER: browser + traffic ===
        self.browser_view = QWebEngineView()
        self.browser_view.setHtml(
            "<body style='background:#0d1117;display:flex;align-items:center;justify-content:center;"
            "height:100vh;margin:0;font-family:sans-serif;color:#484f58;font-size:16px'>"
            "🌐 输入站点 URL 后点击「打开浏览器」</body>"
        )

        self.traffic_table = QTableWidget(0, 6)
        self.traffic_table.setHorizontalHeaderLabels(["Method", "Host", "Path", "Status", "RT(ms)", "Type"])
        self.traffic_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.traffic_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.traffic_table.cellClicked.connect(self._on_flow_click)

        self.req_view = QPlainTextEdit()
        self.req_view.setReadOnly(True)
        self.req_view.setStyleSheet("font-family:'Consolas',monospace; font-size:11px; color:#c9d1d9; background:#161b22;")
        self.resp_view = QPlainTextEdit()
        self.resp_view.setReadOnly(True)
        self.resp_view.setStyleSheet("font-family:'Consolas',monospace; font-size:11px; color:#c9d1d9; background:#161b22;")
        detail_tabs = QTabWidget()
        detail_tabs.addTab(self.req_view, "Request")
        detail_tabs.addTab(self.resp_view, "Response")

        traffic_split = QSplitter(Qt.Vertical)
        traffic_split.addWidget(self.traffic_table)
        traffic_split.addWidget(detail_tabs)
        traffic_split.setStretchFactor(0, 1)
        traffic_split.setStretchFactor(1, 1)

        center = QSplitter(Qt.Vertical)
        center.addWidget(self.browser_view)
        center.addWidget(traffic_split)
        center.setStretchFactor(0, 3)
        center.setStretchFactor(1, 2)

        # === RIGHT: attack surface DAG ===
        # graph_view uses a _NoNavPage that REFUSES all http navigation, so
        # nothing can ever make a real site render inside the graph panel.
        self.graph_view = QWebEngineView()
        self.graph_view.setPage(_NoNavPage(self.graph_view))
        self.graph_view.setHtml(_render_dag_html([], []))
        graph_wrap = QWidget()
        graph_layout = QVBoxLayout(graph_wrap)
        graph_layout.setContentsMargins(0, 0, 0, 0)
        graph_layout.addWidget(self.graph_view)

        # === BOTTOM: event log ===
        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setStyleSheet("font-family:monospace; font-size:10px; color:#8b949e; background:#0d1117;")

        # === FIXED LAYOUT: one top-level horizontal splitter, no docks ===
        # Left(300px) | Center(browser+traffic) | Right(graph). Sizes are set
        # and locked so panels can't drift or be overridden by QWebEngine focus.
        main_split = QSplitter(Qt.Horizontal)
        main_split.addWidget(left_scroll)
        main_split.addWidget(center)
        main_split.addWidget(graph_wrap)
        main_split.setStretchFactor(0, 0)   # left fixed
        main_split.setStretchFactor(1, 3)   # center grows
        main_split.setStretchFactor(2, 2)   # right grows
        main_split.setSizes([300, 900, 600])
        # Lock the left panel width; allow center/right to resize but keep min
        main_split.setCollapsible(0, False)
        main_split.setCollapsible(1, False)
        main_split.setCollapsible(2, False)
        self.graph_view.setMinimumWidth(380)
        self.browser_view.setMinimumWidth(400)

        # Vertical splitter: main_split on top, event log on bottom
        root_split = QSplitter(Qt.Vertical)
        root_split.addWidget(main_split)
        root_split.addWidget(self.log_view)
        root_split.setStretchFactor(0, 5)
        root_split.setStretchFactor(1, 1)
        root_split.setSizes([800, 160])
        root_split.setCollapsible(0, False)
        root_split.setCollapsible(1, False)
        self.setCentralWidget(root_split)
        self._main_split = main_split
        self._root_split = root_split

    # ---- logging ----
    def _log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self.log_view.appendPlainText(f"[{ts}] {msg}")

    # ---- browser ----
    def _on_open_browser(self) -> None:
        target = self.target_input.text().strip()
        if not target:
            return
        from PySide6.QtCore import QUrl
        self.browser_view.setUrl(QUrl(target))
        self._log(f"🌐 浏览器导航到 {target}")

    # ---- traffic click ----
    def _on_flow_click(self, row: int, col: int) -> None:
        run_dir = self._current_run_dir
        if not run_dir or row >= len(self._cached_flows):
            return
        fid = self._cached_flows[row].get("id", "")
        detail = _read_flow_detail(run_dir, fid)
        if detail:
            self.req_view.setPlainText(_format_http(detail, "request"))
            self.resp_view.setPlainText(_format_http(detail, "response"))

    # ---- live refresh ----
    def _refresh(self) -> None:
        # Follow the latest run dir under wormhole_runs/: the dashboard shows
        # the most recent run's data and switches automatically when a newer
        # run dir appears.
        run_dir = _latest_run_dir()
        if run_dir is None or not run_dir.exists():
            return
        if run_dir != self._current_run_dir:
            self._current_run_dir = run_dir
            self._last_graph_sig = ""  # force graph re-render for the new run
            self._log(f"📂 跟踪运行数据: {run_dir}")
        # Traffic
        flows = _read_proxy_flows(run_dir)
        self._cached_flows = flows
        self.traffic_table.setRowCount(len(flows))
        for i, f in enumerate(flows):
            self.traffic_table.setItem(i, 0, QTableWidgetItem(f.get("method", "")))
            self.traffic_table.setItem(i, 1, QTableWidgetItem(f.get("host", "")))
            self.traffic_table.setItem(i, 2, QTableWidgetItem(f.get("path", "")))
            s = f.get("status")
            si = QTableWidgetItem(str(s) if s else "-")
            if isinstance(s, int):
                if 200 <= s < 300: si.setForeground(Qt.darkGreen)
                elif 400 <= s < 500: si.setForeground(Qt.yellow)
                elif s >= 500: si.setForeground(Qt.red)
            self.traffic_table.setItem(i, 3, si)
            self.traffic_table.setItem(i, 4, QTableWidgetItem(str(f.get("rt") or "-")))
            self.traffic_table.setItem(i, 5, QTableWidgetItem(f.get("cat", "")))
        # Surface stats
        nodes = _read_surface_nodes(run_dir)
        if nodes:
            types = {}
            for n in nodes:
                t = n.get("type", "?")
                types[t] = types.get(t, 0) + 1
            parts = [f"{t}:{c}" for t, c in sorted(types.items())]
            self.stat_label.setText("  ".join(parts))
        # Business understanding list: function nodes = explored business
        # functions. calls_endpoints are stored as "calls" edges (not in node
        # data), so read edges first and group them.
        edges = _read_surface_edges(run_dir)
        calls_by_fn: dict[str, list[str]] = {}
        for e in edges:
            if e.get("relation") == "calls":
                calls_by_fn.setdefault(e["src"], []).append(e["dst"])
        func_nodes = [n for n in nodes if n.get("type") == "function"]
        self.biz_list.setRowCount(len(func_nodes))
        for i, fn in enumerate(func_nodes):
            d = fn.get("data", {})
            self.biz_list.setItem(i, 0, QTableWidgetItem(str(d.get("name", "?"))))
            eps = calls_by_fn.get(fn["id"], [])
            ep_str = ", ".join(str(e)[:12] for e in eps[:4]) + ("…" if len(eps) > 4 else "")
            self.biz_list.setItem(i, 1, QTableWidgetItem(ep_str or "-"))
        # DAG graph — pass origin (target URL) + goal so the origin→facts→goal
        # loop is rendered explicitly.
        origin = self.target_input.text().strip()
        goal = self.goal_edit.toPlainText().strip()
        # Re-render when node/edge count changes OR when a finding first appears
        # (so the closes-loop edge draws as soon as a finding lands).
        has_finding = any(n.get("type") == "finding" for n in nodes)
        sig = f"{len(nodes)}:{len(edges)}:f{int(has_finding)}"
        if sig != self._last_graph_sig:
            self._last_graph_sig = sig
            self.graph_view.setHtml(_render_dag_html(nodes, edges, origin=origin, goal=goal))


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # Load .env from CWD if present so WORMHOLE_* overrides take effect.
    # Existing env vars win (dotenv default override=False).
    try:
        from dotenv import load_dotenv
        load_dotenv()  # does NOT clobber existing os.environ
    except ImportError:
        pass
    app = QApplication(["wormhole"])
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
