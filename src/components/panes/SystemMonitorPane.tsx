// System-monitor pane: CPU / memory / GPU / network, polled from Rust (sysinfo +
// nvml) on the pane's own interval. Settings (interval + which sections show)
// live on the pane, so they persist in the app's data/ folder like everything else.
// ponytail: sparklines are hand-rolled inline SVG — a charting dep for four
// 60-point polylines would be overkill; swap in one if these grow axes/tooltips.
import { useEffect, useState } from "react";
import { sysSnapshot, type Metrics } from "../../lib/ipc";
import { useLayout } from "../../stores/layout";
import { DEFAULT_MONITOR, type MonitorConfig, type Pane } from "../../lib/layout-tree";

const HISTORY = 60; // samples kept per sparkline

const COL = { cpu: "#4c8bf5", mem: "#5fbf6a", gpu: "#e0a44c", net: "#46c7c7" };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function push(arr: number[], v: number): number[] {
  const next = arr.length >= HISTORY ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

function Sparkline({ data, color, max }: { data: number[]; color: string; max: number }) {
  const w = 100, h = 24;
  if (data.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }} preserveAspectRatio="none" />;
  const top = Math.max(max, ...data) || 1;
  const step = w / (HISTORY - 1);
  const pts = data.map((v, i) => `${(i + (HISTORY - data.length)) * step},${h - (v / top) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block" }} preserveAspectRatio="none">
      <polyline points={`${pts} ${w},${h} ${(HISTORY - data.length) * step},${h}`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ label, sub, pct, color, history, max = 100 }: {
  label: string; sub: string; pct: number; color: string; history: number[]; max?: number;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{label}</span>
        <span style={{ color: "var(--muted)" }}>{sub}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "var(--panel-2)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: color, transition: "width .3s" }} />
      </div>
      <Sparkline data={history} color={color} max={max} />
    </div>
  );
}

interface Hist { cpu: number[]; mem: number[]; gpu: number[]; net: number[] }
const EMPTY: Hist = { cpu: [], mem: [], gpu: [], net: [] };

export default function SystemMonitorPane({ pane }: { pane: Pane }) {
  const cfg: MonitorConfig = { ...DEFAULT_MONITOR, ...pane.monitor };
  const patchPane = useLayout((s) => s.patchPane);
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState(false);
  const [hist, setHist] = useState<Hist>(EMPTY);
  const [gear, setGear] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const data = await sysSnapshot();
        if (!live) return;
        setErr(false);
        setM(data);
        const net = data.netRx + data.netTx;
        const gpu = data.gpus[0]?.util ?? 0;
        const mem = data.memTotal ? (data.memUsed / data.memTotal) * 100 : 0;
        setHist((h) => ({ cpu: push(h.cpu, data.cpu), mem: push(h.mem, mem), gpu: push(h.gpu, gpu), net: push(h.net, net) }));
      } catch {
        if (live) setErr(true); // plain browser (no Tauri) or backend error
      }
    };
    tick();
    const id = setInterval(tick, Math.max(200, cfg.intervalMs));
    return () => { live = false; clearInterval(id); };
  }, [cfg.intervalMs]);

  const set = (patch: Partial<MonitorConfig>) => patchPane(pane.id, { monitor: { ...cfg, ...patch } });

  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const netMax = Math.max(1, ...hist.net);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 16, background: "var(--bg)", fontSize: 13 }}>
      <button title="Monitor settings" onClick={() => setGear((v) => !v)}
        style={{ position: "absolute", top: 8, right: 10, background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15 }}>⚙</button>

      {gear && (
        <>
          <div onClick={() => setGear(false)} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
          <div style={{ position: "absolute", top: 30, right: 10, zIndex: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, minWidth: 170, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, color: "var(--text)" }}>
              Refresh (ms)
              <input type="number" min={200} step={100} value={cfg.intervalMs}
                onChange={(e) => set({ intervalMs: Math.max(200, Number(e.target.value) || DEFAULT_MONITOR.intervalMs) })}
                style={{ width: 64, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px" }} />
            </label>
            {([["showCpu", "CPU"], ["showMem", "Memory"], ["showGpu", "GPU"], ["showNet", "Network"]] as const).map(([k, lbl]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", color: "var(--text)", cursor: "pointer" }}>
                <input type="checkbox" checked={cfg[k]} onChange={(e) => set({ [k]: e.target.checked })} />
                {lbl}
              </label>
            ))}
          </div>
        </>
      )}

      {err && <div style={{ color: "var(--muted)" }}>System metrics unavailable (needs the desktop app).</div>}

      {m && (
        <>
          {cfg.showCpu && (
            <Meter label="CPU" sub={`${m.cpu.toFixed(0)}%${m.temp != null ? ` · ${m.temp.toFixed(0)}°C` : ""}`}
              pct={m.cpu} color={COL.cpu} history={hist.cpu} />
          )}
          {cfg.showCpu && m.cores.length > 1 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(8, m.cores.length)}, 1fr)`, gap: 4, marginBottom: 14 }}>
              {m.cores.map((c, i) => (
                <div key={i} title={`Core ${i}: ${c.toFixed(0)}%`} style={{ height: 26, background: "var(--panel-2)", borderRadius: 2, display: "flex", alignItems: "flex-end", overflow: "hidden" }}>
                  <div style={{ width: "100%", height: `${c}%`, background: COL.cpu, opacity: 0.7 }} />
                </div>
              ))}
            </div>
          )}

          {cfg.showMem && (
            <Meter label="Memory" sub={`${fmtBytes(m.memUsed)} / ${fmtBytes(m.memTotal)}`} pct={memPct} color={COL.mem} history={hist.mem} />
          )}
          {cfg.showMem && m.swapTotal > 0 && (
            <Meter label="Swap" sub={`${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}`}
              pct={(m.swapUsed / m.swapTotal) * 100} color={COL.mem} history={[]} />
          )}

          {cfg.showGpu && m.gpus.map((g, i) => (
            <Meter key={i} label={g.name || `GPU ${i}`}
              sub={`${g.util}% · ${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}${g.temp != null ? ` · ${g.temp}°C` : ""}`}
              pct={g.util} color={COL.gpu} history={i === 0 ? hist.gpu : []} />
          ))}
          {cfg.showGpu && m.gpus.length === 0 && (
            <div style={{ color: "var(--muted)", marginBottom: 14, fontSize: 12 }}>No NVIDIA GPU detected.</div>
          )}

          {cfg.showNet && (
            <Meter label="Network" sub={`↓ ${fmtBytes(m.netRx)}/s · ↑ ${fmtBytes(m.netTx)}/s`}
              pct={((m.netRx + m.netTx) / netMax) * 100} color={COL.net} history={hist.net} max={netMax} />
          )}
        </>
      )}
    </div>
  );
}
