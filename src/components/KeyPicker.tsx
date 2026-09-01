import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  KEY_GROUPS, MODIFIER_TOKENS, canonicalToken, comboFromEvent, filterGroups,
  isKnownToken, joinCombo, keyLabel, splitCombo, tokenFromCode, IS_MODIFIER_CODE,
  type ModifierToken,
} from "../lib/keys";
import "./macros.css";

/* Key field shared by the global-hotkey trigger and every macro step that
   names a key. Recording covers what the keyboard has; the picker covers the
   rest (media keys, F13-F24, numpad, …) — see src/lib/keys.ts for the catalog
   and why the token spellings are what they are.

   `single` is the hold_key / release_key shape: one token, no modifier tail. */
export function KeyField({ value, onChange, single, placeholder, trailing }: {
  value: string;
  onChange: (v: string) => void;
  single?: boolean;
  placeholder?: string;
  /** Extra control rendered at the end of the row (the macro editor's fx toggle). */
  trailing?: React.ReactNode;
}) {
  const [capturing, setCapturing] = useState(false);
  const [picking, setPicking] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === "Escape") return setCapturing(false);
      if (IS_MODIFIER_CODE(e.code)) return;
      const combo = single ? tokenFromCode(e.code) : comboFromEvent(e);
      if (!combo) return;
      onChange(combo);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onChange, single]);

  const unknown = !!value && !isKnownToken(single ? value : splitCombo(value).key);

  return (
    <>
      <div className="mac-row" ref={rowRef} style={{ position: "relative" }}>
        <button className="mac-input mac-mono kp-record"
          title={single ? "Click, then press the key" : "Click, then press the combo"}
          style={{ color: capturing ? "var(--accent)" : value ? "var(--text)" : "var(--muted)" }}
          onClick={() => { setPicking(false); setCapturing((v) => !v); }}>
          {capturing ? "press keys… (Esc cancels)" : value || placeholder || "click to record"}
        </button>
        <button className={`mac-fx kp-more${picking ? " on" : ""}`} title="Pick a key the keyboard cannot press (media, F13+, numpad…)"
          onClick={() => { setCapturing(false); setPicking((v) => !v); }}>⌨▾</button>
        {trailing}
      </div>
      {unknown && (
        <div className="kp-warn">
          “{single ? value : splitCombo(value).key}” is not a key either backend knows — pick one from ⌨▾.
        </div>
      )}
      {picking && (
        <KeyPickerPanel anchor={rowRef.current} value={value} single={!!single}
          onPick={(v) => { onChange(v); setPicking(false); }}
          onClose={() => setPicking(false)} />
      )}
    </>
  );
}

function KeyPickerPanel({ anchor, value, single, onPick, onClose }: {
  anchor: HTMLElement | null;
  value: string;
  single: boolean;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [mods, setMods] = useState<ModifierToken[]>(() => (single ? [] : splitCombo(value).mods));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fixed-positioned: the inspector and the hotkey pane both scroll/clip.
  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    const width = 340, height = 380;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [anchor, onClose]);

  const toggleMod = useCallback((m: ModifierToken) =>
    setMods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m])), []);

  const groups = filterGroups(search, { modifiers: single });
  const current = single ? canonicalToken(value) : canonicalToken(splitCombo(value).key);

  return (
    <div className="kp-panel" ref={panelRef} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onClick={(e) => e.stopPropagation()}>
      <input className="mac-input" autoFocus placeholder="Search keys… (e.g. play, volume, numpad)"
        value={search} onChange={(e) => setSearch(e.target.value)} />
      {!single && (
        <div className="kp-mods">
          {MODIFIER_TOKENS.map((m) => (
            <button key={m} className={`mac-btn tiny${mods.includes(m) ? " primary" : ""}`} onClick={() => toggleMod(m)}>{m}</button>
          ))}
          <span className="kp-preview mac-mono">{joinCombo(mods, "…")}</span>
        </div>
      )}
      <div className="kp-list">
        {groups.length === 0 && <div className="kp-empty">No key matches “{search}”.</div>}
        {groups.map((g) => (
          <div key={g.cat}>
            <div className="mac-cat">{g.cat}</div>
            <div className="kp-keys">
              {g.keys.map((k) => (
                <button key={k.token} title={k.token}
                  className={`kp-key${current === k.token ? " sel" : ""}`}
                  onClick={() => onPick(single ? k.token : joinCombo(mods, k.token))}>
                  {k.label ?? k.token}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="kp-foot">
        {single
          ? "One key per step — modifiers count as keys here."
          : `Modifiers apply to the key you click. Current: ${value ? keyLabel(splitCombo(value).key) : "(unset)"}`}
      </div>
    </div>
  );
}

/** Every token the picker can produce — used by tests and by callers that
 *  want to validate a hand-typed value. */
export const ALL_KEY_TOKENS = KEY_GROUPS.flatMap((g) => g.keys.map((k) => k.token));
