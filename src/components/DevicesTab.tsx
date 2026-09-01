import { useEffect, useRef, useState } from "react";
import { devicesAudio, devicesUsb, type AudioDeviceDto, type UsbDeviceDto } from "./MacroEditor";
import "./macros.css";

/* Live device view (KeyForge app.rs Devices tab). Polls the audio endpoints
   and connected USB devices every ~2s via the task-5 backend commands
   (devices_audio / devices_usb, both enumerated on a scratch COM thread). */

export default function DevicesTab({ active }: { active: boolean }) {
  const [audio, setAudio] = useState<AudioDeviceDto[]>([]);
  const [usb, setUsb] = useState<UsbDeviceDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number>(0);
  const busy = useRef(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const [a, u] = await Promise.all([devicesAudio(), devicesUsb()]);
        if (!live) return;
        setAudio(a); setUsb(u); setErr(null); setLastOk(Date.now());
      } catch (e) {
        if (live) setErr(String(e));
      } finally { busy.current = false; }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { live = false; clearInterval(id); };
  }, [active]);

  const outputs = audio.filter((d) => d.output);
  const inputs = audio.filter((d) => !d.output);

  return (
    <div className="mac-devices">
      <div className="mac-dev-toolbar">
        <span>Live devices — refreshing every 2s</span>
        <div style={{ flex: 1 }} />
        {err ? <span style={{ color: "#e88" }}>⚠ {err}</span> : <span>{lastOk ? `updated ${new Date(lastOk).toLocaleTimeString()}` : "…"}</span>}
      </div>
      <div className="mac-dev-body">
        <div className="mac-dev-col">
          <h4>Audio output ({outputs.length})</h4>
          {outputs.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>None.</div>}
          {outputs.map((d) => <AudioRow key={d.id} d={d} />)}
          <h4 style={{ marginTop: 16 }}>Audio input ({inputs.length})</h4>
          {inputs.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>None.</div>}
          {inputs.map((d) => <AudioRow key={d.id} d={d} />)}
        </div>
        <div className="mac-dev-col">
          <h4>USB devices ({usb.length})</h4>
          {usb.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>None.</div>}
          {usb.map((d, i) => (
            <div className="mac-dev-item" key={d.instance_id || i}>
              <span className="mac-dev-dot" style={{ background: "#5a8" }} />
              <span className="mac-dev-name" title={d.instance_id}>{d.name || "(unnamed device)"}</span>
              <span className="mac-dev-meta">{d.vid}:{d.pid}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AudioRow({ d }: { d: AudioDeviceDto }) {
  return (
    <div className={`mac-dev-item${d.default ? " default" : ""}`}>
      <span className="mac-dev-dot" style={{ background: d.default ? "var(--accent)" : "#666" }} />
      <span className="mac-dev-name" title={d.id}>{d.name}</span>
      {d.default && <span className="mac-dev-badge">DEFAULT</span>}
    </div>
  );
}
