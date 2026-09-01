import { useCallback, useEffect, useRef, useState } from "react";
import {
  voiceGetSettings,
  voiceSetSettings,
  voiceListMics,
  voiceStatus,
  voiceModelsStatus,
  voiceModelDownload,
  voiceModelImport,
  onVoiceModel,
  onVoiceModelProgress,
  type VoiceSettings as VS,
  type VoiceStatus,
  type VoiceModelInfo,
  type VoiceModelProgress,
} from "../lib/ipc";
import { field, label as labelStyle, row as rowStyle } from "../lib/uiStyles";
import "./voice.css";

// Voice-To-Text settings (VoiceMarch fold-in). Pixel-matches VoiceMarch's
// settings panel (Z:/SVN/VoiceMarch/src/index.html + styles.css). The same field
// rows are reused by the main Settings menu (the `VoiceCategory` default export,
// listed in SettingsModal's category registry) AND by the standalone voice
// window's expanded panel — one component, two hosts.

// A few VoiceMarch fields (start-on-login + the hands-free advanced numbers) are
// not yet in the shared VoiceSettings IPC type (that struct is owned by the voice
// backend task). Read/write them through this superset so the UI carries them
// end-to-end the moment the backend adds them; unknown extras ride along on the
// object we hand back to voice_set_settings untouched.
type FullVS = VS & {
  start_on_login?: boolean;
  mic_sensitivity?: number;
  end_of_speech_ms?: number;
};

const MODELS: Array<{ value: string; label: string }> = [
  { value: "base.en-q8_0", label: "base.en — accurate (default)" },
  { value: "base.en", label: "base.en (f16) — largest" },
  { value: "tiny.en", label: "tiny.en — fastest" },
];

// ── Model installer (pure logic; the rendering sits in ModelInstaller below) ──
// No GGML model ships with the app, and a missing one used to fail SILENTLY: the
// PTT press recorded, transcription was skipped, the pill went back to idle. So
// this panel has to both explain the state and fix it.

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function percent(downloaded: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}

export type ModelRowState = "installed" | "downloading" | "verifying" | "incomplete" | "missing";
export interface ModelRow {
  state: ModelRowState;
  detail: string;
  busy: boolean;       // an install is in flight — disable this row's buttons
  progress: number | null; // 0–100, null when the length is unknown
  error: string | null;
}

// What one catalog row should say, given the on-disk facts plus the live event
// for that id (if any). `incomplete` is the important one: a truncated leftover
// is present-but-unusable, and calling it "installed" is how you get a silent
// failure at PTT time.
export function modelRow(info: VoiceModelInfo, prog?: VoiceModelProgress): ModelRow {
  if (prog && (prog.status === "start" || prog.status === "progress")) {
    const pct = percent(prog.downloaded, prog.total);
    return {
      state: "downloading",
      detail: `Downloading ${formatBytes(prog.downloaded)} of ${formatBytes(prog.total)}${pct == null ? "" : ` (${pct}%)`}`,
      busy: true,
      progress: pct,
      error: null,
    };
  }
  if (prog && prog.status === "verifying") {
    return { state: "verifying", detail: "Verifying checksum…", busy: true, progress: 100, error: null };
  }
  const error = prog && prog.status === "error" ? prog.error || "download failed" : null;
  if (info.complete) {
    return { state: "installed", detail: `Installed — ${formatBytes(info.size_bytes)}`, busy: false, progress: null, error };
  }
  if (info.present) {
    return {
      state: "incomplete",
      detail: `Damaged or partial — ${formatBytes(info.size_bytes)} on disk, expected ${formatBytes(info.expected_size)}`,
      busy: false,
      progress: null,
      error,
    };
  }
  return {
    state: "missing",
    detail: info.expected_size == null ? "Not installed" : `Not installed — ${formatBytes(info.expected_size)} download`,
    busy: false,
    progress: null,
    error,
  };
}

// Fold a progress event into the per-id map. A finished install drops out (the
// refreshed on-disk status takes over); an error sticks around so the user can
// read why.
export function progressReducer(
  state: Record<string, VoiceModelProgress>,
  ev: VoiceModelProgress,
): Record<string, VoiceModelProgress> {
  if (ev.status === "done") {
    if (!(ev.id in state)) return state;
    const next = { ...state };
    delete next[ev.id];
    return next;
  }
  return { ...state, [ev.id]: ev };
}

const btn: React.CSSProperties = { ...field, cursor: "pointer", whiteSpace: "nowrap" };

function ModelInstaller({ status }: { status: VoiceStatus | null }) {
  const [models, setModels] = useState<VoiceModelInfo[] | null>(null);
  const [prog, setProg] = useState<Record<string, VoiceModelProgress>>({});
  const [err, setErr] = useState("");
  const alive = useRef(true);

  const refresh = useCallback(() => {
    voiceModelsStatus()
      .then((m) => { if (alive.current) setModels(m); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    // Two live sources, so the panel never shows a stale "not found": the audio
    // thread's own load state, and our download/import progress.
    const un = [
      onVoiceModel(() => refresh()),
      onVoiceModelProgress((ev) => {
        if (!alive.current) return;
        setProg((p) => progressReducer(p, ev));
        if (ev.status === "done" || ev.status === "error") refresh();
      }),
    ];
    return () => {
      alive.current = false;
      un.forEach((p) => p.then((f) => f()).catch(() => {}));
    };
  }, [refresh]);

  // Nothing to install into: the engine isn't in this build at all.
  if (status && !status.built) return null;

  const download = (id: string) => {
    setErr("");
    voiceModelDownload(id).catch((e) => setErr(String(e)));
  };
  const importFile = (id: string) => {
    setErr("");
    voiceModelImport(id)
      .then((name) => { if (name) refresh(); })
      .catch((e) => setErr(String(e)));
  };

  return (
    <details className="adv" open={!!status && !status.model_present}>
      <summary>Speech models{models ? ` (${models.filter((m) => m.complete).length}/${models.length} installed)` : ""}</summary>
      <p style={{ ...labelStyle, margin: "8px 0 0" }}>
        Dictation needs a Whisper model file next to the app. None ship with it —
        download one here (from huggingface.co over HTTPS, checksum-verified), or
        pick a <code>.bin</code> you already have.
      </p>
      {err && <p className="error">{err}</p>}
      {models?.map((m) => {
        const r = modelRow(m, prog[m.id]);
        return (
          <div key={m.id} style={{ ...rowStyle, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 60%", minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>
                {r.state === "installed" ? "✓ " : ""}{m.label}
                {m.selected && <span style={{ ...labelStyle, marginLeft: 6 }}>· selected</span>}
              </div>
              {/* break-word, not break-all: the latter split mid-number in the
                  narrow settings column ("— 7\n8 MB download"). Only the long
                  filename needs to be breakable. */}
              <div style={{ ...labelStyle, overflowWrap: "break-word" }}>{m.file} — {r.detail}</div>
              {r.progress != null && r.busy && (
                <progress value={r.progress} max={100} style={{ width: "100%", height: 6 }} />
              )}
              {r.error && <div className="error">{r.error}</div>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {m.url && (
                <button type="button" style={btn} disabled={r.busy} onClick={() => download(m.id)}>
                  {r.busy ? "…" : r.state === "installed" ? "Re-download" : "Download"}
                </button>
              )}
              <button type="button" style={btn} disabled={r.busy} onClick={() => importFile(m.id)}>
                Browse…
              </button>
            </div>
          </div>
        );
      })}
    </details>
  );
}

// The labeled field rows, in VoiceMarch order. Rendered inside a `.panel`
// (window) or `.panel.panel--embed` (Settings modal); both get the green accent
// + identical field styling from voice.css. `onError` surfaces a failed save to
// the host's `.error` line.
export function VoiceSettingsForm({ onError }: { onError?: (msg: string) => void } = {}) {
  const [s, setS] = useState<FullVS | null>(null);
  const [mics, setMics] = useState<string[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  const readStatus = useCallback(
    () => voiceStatus().then(setStatus).catch(() => {}),
    [],
  );

  useEffect(() => {
    voiceGetSettings().then(setS).catch(() => {});
    voiceListMics().then(setMics).catch(() => {});
    readStatus();
    // The warning below must not go stale: re-read whenever the audio thread
    // reports a model load state and whenever an install finishes.
    const un = [
      onVoiceModel(() => readStatus()),
      onVoiceModelProgress((ev) => { if (ev.status === "done") readStatus(); }),
    ];
    return () => un.forEach((p) => p.then((f) => f()).catch(() => {}));
  }, [readStatus]);

  if (!s) return <label style={{ padding: 8 }}>Loading voice settings…</label>;

  // Persist on every change so the window and the audio thread pick it up live.
  const patch = (p: Partial<FullVS>) => {
    const next = { ...s, ...p };
    setS(next);
    onError?.("");
    voiceSetSettings(next as VS)
      // Switching whisper_model changes which file is "the" model, so the
      // presence warning has to be re-derived after every save.
      .then(readStatus)
      .catch((err) => onError?.(String(err)));
  };

  // Master switch. Off means the backend drops the global PTT grab, hides the
  // pill and greys out the tray entry — so there is nothing left to configure
  // and the rest of the form is not rendered. Everything below stays PERSISTED,
  // so flipping it back on restores the user's setup untouched.
  const enabled = s.enabled !== false;

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        Enable Voice-To-Text
      </label>
      {!enabled && (
        <p style={{ ...labelStyle, margin: "6px 0 0" }}>
          Dictation is off: the push-to-talk hotkey is released back to the
          system, the microphone is never opened, and the floating pill and its
          toolbar button are hidden. Your settings are kept for when you turn it
          back on.
        </p>
      )}
      {enabled && <VoiceFields s={s} patch={patch} status={status} mics={mics} />}
    </>
  );
}

// The configuration rows themselves — split out so the master switch above can
// drop them wholesale without threading a `disabled` prop through every input.
function VoiceFields({
  s,
  patch,
  status,
  mics,
}: {
  s: FullVS;
  patch: (p: Partial<FullVS>) => void;
  status: VoiceStatus | null;
  mics: string[];
}) {
  return (
    <>
      {/* Two independent failures, in the order that matters: a build with no
          engine can't be fixed by downloading anything, so say so and offer
          nothing. Only a built engine gets the installer. */}
      {status && !status.built && (
        <p className="error" style={{ color: "#f59e0b" }}>
          This build has no voice engine (compiled without the <code>voice</code>{" "}
          feature). Settings save, but dictation is inactive and no model can help
          — you need a build with voice enabled.
        </p>
      )}
      {status && status.built && !status.model_present && (
        <p className="error" style={{ color: "#f59e0b" }}>
          No speech model installed ({status.model_file} is missing), so dictation
          silently produces nothing. Install one under “Speech models” below.
        </p>
      )}
      <ModelInstaller status={status} />

      <label>
        PTT hotkey
        <input
          type="text"
          spellCheck={false}
          placeholder="F8"
          value={s.ptt_hotkey}
          onChange={(e) => patch({ ptt_hotkey: e.target.value })}
        />
      </label>
      <label>
        Microphone
        <select value={s.mic_device ?? ""} onChange={(e) => patch({ mic_device: e.target.value || null })}>
          <option value="">System default</option>
          {mics.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label>
        Whisper model
        <select value={s.whisper_model} onChange={(e) => patch({ whisper_model: e.target.value })}>
          {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          {!MODELS.some((m) => m.value === s.whisper_model) && (
            <option value={s.whisper_model}>{s.whisper_model}</option>
          )}
        </select>
      </label>
      <label>
        Spacing
        <select value={s.spacing} onChange={(e) => patch({ spacing: e.target.value as VS["spacing"] })}>
          <option value="space">space</option>
          <option value="newline">newline</option>
          <option value="none">none</option>
        </select>
      </label>
      <label>
        Punctuation
        <select value={s.punctuation} onChange={(e) => patch({ punctuation: e.target.value as VS["punctuation"] })}>
          <option value="keep">keep</option>
          <option value="strip">strip</option>
          <option value="spoken">spoken</option>
        </select>
      </label>
      <label>
        Insertion
        <select value={s.insertion} onChange={(e) => patch({ insertion: e.target.value })}>
          <option value="paste">paste</option>
          <option value="type">type</option>
        </select>
      </label>

      <label className="check">
        <input type="checkbox" checked={s.chirp} onChange={(e) => patch({ chirp: e.target.checked })} />
        Sound on PTT press/release
      </label>
      <label>
        Sound volume
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={s.chirp_volume}
          onChange={(e) => patch({ chirp_volume: parseInt(e.target.value, 10) })}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={s.mute_on_ptt} onChange={(e) => patch({ mute_on_ptt: e.target.checked })} />
        Mute system audio while dictating
      </label>
      <label className="check">
        <input type="checkbox" checked={s.always_on_top} onChange={(e) => patch({ always_on_top: e.target.checked })} />
        Always on top
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s.start_on_login ?? false}
          onChange={(e) => patch({ start_on_login: e.target.checked })}
        />
        Start on login
      </label>

      <details className="adv">
        <summary>Hands-free (advanced)</summary>
        <label>
          Mic sensitivity (RMS)
          <input
            type="number"
            step={0.001}
            min={0}
            value={s.mic_sensitivity ?? ""}
            onChange={(e) => patch({ mic_sensitivity: parseFloat(e.target.value) || 0 })}
          />
        </label>
        <label>
          End-of-speech pause (ms)
          <input
            type="number"
            step={50}
            min={0}
            value={s.end_of_speech_ms ?? ""}
            onChange={(e) => patch({ end_of_speech_ms: parseInt(e.target.value, 10) || 0 })}
          />
        </label>
      </details>
    </>
  );
}

// Settings-menu category wrapper (registry entry in SettingsModal.tsx). Renders
// the shared fields with the window chrome stripped but the VoiceMarch field
// styling kept.
export default function VoiceCategory() {
  return (
    <div className="panel panel--embed">
      <VoiceSettingsForm />
    </div>
  );
}
