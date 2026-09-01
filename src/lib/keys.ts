/* =====================================================================
   Key catalog shared by every key field in the hotkey / macro editor:
   the global-hotkey trigger capture (HotkeyManager) and the macro steps
   that send keys (send_keystroke / hold_key / release_key).

   A keyboard can only record what it physically has — media keys, F13+,
   numpad and the rest are unreachable on most boards. So every key field
   pairs "record" with a picker over this catalog.

   Tokens are spelled so BOTH backend parsers accept them verbatim:
     • trigger side — global-hotkey's parse_key (tauri global-shortcut)
     • send side    — src-tauri/src/macros/input.rs parse_key_token
   A token added here MUST parse in input.rs, or the step fails at run time.
   ===================================================================== */

export interface KeyDef {
  token: string;
  /** Human label; defaults to the token. */
  label?: string;
}
export interface KeyGroup {
  cat: string;
  keys: KeyDef[];
  /** Modifier keys: pickable on their own (hold_key), never as a combo tail. */
  modifiers?: boolean;
}

export const MODIFIER_TOKENS = ["Ctrl", "Alt", "Shift", "Super"] as const;
export type ModifierToken = (typeof MODIFIER_TOKENS)[number];

const chars = (s: string): KeyDef[] => s.split("").map((c) => ({ token: c }));
const fkeys = (from: number, to: number): KeyDef[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ token: `F${from + i}` }));

export const KEY_GROUPS: KeyGroup[] = [
  {
    cat: "Media & volume",
    keys: [
      { token: "MediaPlayPause", label: "Play / Pause" },
      { token: "MediaStop", label: "Stop" },
      { token: "MediaTrackNext", label: "Next track" },
      { token: "MediaTrackPrev", label: "Previous track" },
      { token: "AudioVolumeUp", label: "Volume up" },
      { token: "AudioVolumeDown", label: "Volume down" },
      { token: "AudioVolumeMute", label: "Mute" },
    ],
  },
  { cat: "Letters", keys: chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ") },
  { cat: "Digits", keys: chars("0123456789") },
  { cat: "Function", keys: [...fkeys(1, 12), ...fkeys(13, 24)] },
  {
    cat: "Navigation",
    keys: [
      { token: "ArrowUp", label: "↑ Up" },
      { token: "ArrowDown", label: "↓ Down" },
      { token: "ArrowLeft", label: "← Left" },
      { token: "ArrowRight", label: "→ Right" },
      { token: "Home" }, { token: "End" },
      { token: "PageUp", label: "Page Up" }, { token: "PageDown", label: "Page Down" },
    ],
  },
  {
    cat: "Editing & system",
    keys: [
      { token: "Enter" }, { token: "Tab" }, { token: "Space" },
      { token: "Backspace" }, { token: "Delete" }, { token: "Insert" },
      { token: "Escape" }, { token: "CapsLock", label: "Caps Lock" },
      { token: "PrintScreen", label: "Print Screen" },
      { token: "ScrollLock", label: "Scroll Lock" },
      { token: "NumLock", label: "Num Lock" },
      { token: "Pause", label: "Pause / Break" },
    ],
  },
  {
    cat: "Numpad",
    keys: [
      ...Array.from({ length: 10 }, (_, i) => ({ token: `Numpad${i}`, label: `Num ${i}` })),
      { token: "NumpadAdd", label: "Num +" },
      { token: "NumpadSubtract", label: "Num −" },
      { token: "NumpadMultiply", label: "Num *" },
      { token: "NumpadDivide", label: "Num /" },
      { token: "NumpadDecimal", label: "Num ." },
      { token: "NumpadEnter", label: "Num Enter" },
    ],
  },
  {
    cat: "Punctuation",
    keys: [
      { token: "Minus", label: "-" }, { token: "Equal", label: "=" },
      { token: "BracketLeft", label: "[" }, { token: "BracketRight", label: "]" },
      { token: "Backslash", label: "\\" }, { token: "Semicolon", label: ";" },
      { token: "Quote", label: "'" }, { token: "Comma", label: "," },
      { token: "Period", label: "." }, { token: "Slash", label: "/" },
      { token: "Backquote", label: "`" },
    ],
  },
  {
    cat: "Modifiers (as a key)",
    modifiers: true,
    keys: [
      { token: "Ctrl" }, { token: "Alt" }, { token: "Shift" }, { token: "Super" },
    ],
  },
];

/** Older spellings that both backends still accept — kept valid, never emitted. */
const ALIASES: Record<string, string> = {
  RETURN: "Enter",
  ESC: "Escape",
  DEL: "Delete",
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
  CONTROL: "Ctrl", WIN: "Super", CMD: "Super", COMMAND: "Super", META: "Super",
  MEDIATRACKPREVIOUS: "MediaTrackPrev", MEDIANEXTTRACK: "MediaTrackNext",
  MEDIAPREVTRACK: "MediaTrackPrev",
  VOLUMEUP: "AudioVolumeUp", VOLUMEDOWN: "AudioVolumeDown", VOLUMEMUTE: "AudioVolumeMute",
  PRINTSCR: "PrintScreen", PLUS: "Equal", NUMPADPLUS: "NumpadAdd",
};

const BY_UPPER = new Map<string, KeyDef>();
for (const g of KEY_GROUPS) for (const k of g.keys) BY_UPPER.set(k.token.toUpperCase(), k);

/** Canonical catalog token for any accepted spelling, or null if unknown. */
export function canonicalToken(token: string): string | null {
  const up = token.trim().toUpperCase();
  if (!up) return null;
  if (BY_UPPER.has(up)) return BY_UPPER.get(up)!.token;
  const alias = ALIASES[up];
  return alias ?? null;
}
export const isKnownToken = (token: string): boolean => canonicalToken(token) !== null;

export function keyLabel(token: string): string {
  const canon = canonicalToken(token);
  if (!canon) return token;
  return BY_UPPER.get(canon.toUpperCase())?.label ?? canon;
}

export const isModifierToken = (token: string): boolean =>
  (MODIFIER_TOKENS as readonly string[]).includes(canonicalToken(token) ?? "");

/** "Ctrl+Shift+MediaPlayPause" → { mods: ["Ctrl","Shift"], key: "MediaPlayPause" } */
export function splitCombo(value: string): { mods: ModifierToken[]; key: string } {
  const parts = String(value ?? "").split("+").map((p) => p.trim()).filter(Boolean);
  const mods: ModifierToken[] = [];
  let key = "";
  for (const p of parts) {
    const canon = canonicalToken(p) ?? p;
    if ((MODIFIER_TOKENS as readonly string[]).includes(canon) && !key) {
      if (!mods.includes(canon as ModifierToken)) mods.push(canon as ModifierToken);
    } else {
      key = p; // last non-modifier wins; a trailing modifier stays the key
    }
  }
  // A combo of nothing but modifiers means the last one is the key itself.
  if (!key && mods.length) key = mods.pop()!;
  return { mods, key };
}

/** Modifiers always in the canonical order the backends print them in. */
export function joinCombo(mods: readonly string[], key: string): string {
  const ordered = MODIFIER_TOKENS.filter((m) => mods.includes(m));
  return [...ordered, key].filter(Boolean).join("+");
}

/** Browser KeyboardEvent.code → catalog token ("KeyA" → "A", "Digit1" → "1"). */
export function tokenFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return canonicalToken(code) ?? code;
}

export const IS_MODIFIER_CODE = (code: string): boolean =>
  /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code);

/** The combo a keydown stands for, or null while only modifiers are held. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (IS_MODIFIER_CODE(e.code)) return null;
  const mods: ModifierToken[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return joinCombo(mods, tokenFromCode(e.code));
}

/** Search over token + label, so "play" finds MediaPlayPause. */
export function filterGroups(query: string, opts?: { modifiers?: boolean }): KeyGroup[] {
  const q = query.trim().toLowerCase();
  const out: KeyGroup[] = [];
  for (const g of KEY_GROUPS) {
    if (g.modifiers && !opts?.modifiers) continue;
    const keys = q
      ? g.keys.filter((k) => k.token.toLowerCase().includes(q) || (k.label ?? "").toLowerCase().includes(q))
      : g.keys;
    if (keys.length) out.push({ ...g, keys });
  }
  return out;
}
