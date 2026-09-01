// Shared inline-style primitives for the modal dialogs (Settings, Launch swarm, …).
// The app uses no Tailwind / CSS modules — dialogs are styled with inline
// CSSProperties consts, and these four were duplicated verbatim in every dialog.
// Colours come from the CSS vars in index.css; ACCENT_SELECTED is the literal
// selection colour of a left-list row (no var exists for it).
import type { CSSProperties } from "react";

export const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 115 };
export const label: CSSProperties = { fontSize: 12, color: "var(--muted)" };
export const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--border)" };
export const field: CSSProperties = { background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 7px", fontSize: 12.5 };

export const ACCENT_SELECTED = "#2b3a55";
