// Screenshot history. The portable screenshots/ folder in the app's data/ folder is never
// pruned, so `screenshot_list` (newest first) can return thousands of paths —
// the grid renders a capped page and says how many are still hidden instead of
// mounting every <img> at once. Per-item actions mirror ScreenshotThumb's
// context menu (crop, OCR, copy, open folder, delete) so there is one set of
// behaviours for a shot no matter where you meet it.
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText as clipboardWriteText, writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { screenshotList } from "../lib/ipc";
import { SHOT_TAKEN_EVENT } from "./ScreenshotOverlay";
import { useLayout } from "../stores/layout";
import { useBackdropClose } from "../lib/useBackdropClose";
import ScreenshotCrop from "./ScreenshotCrop";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// How many thumbs to mount at once; "Load more" adds another page.
const PAGE = 60;

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 119,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const numStyle: React.CSSProperties = {
  width: 62,
  background: "var(--panel-2)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: 11,
};

function baseName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

// Cache-busting for a re-saved shot, shared by this grid and the pinned thumb
// (ScreenshotThumb imports it from here — it already imports this module, so
// there is no cycle). A crop overwrites a path in place and WebView2 then
// serves the stale pixels; the path itself never changes, so the query token
// has to. The counter is monotonic rather than derived from the path because
// the old "path length" trick did not change when a crop kept the same name.
//
// `nextBust()` is deliberately separate from `bustedSrc()`: a token minted
// during render would change on every render and put the <img> in a reload
// loop. Mint one when the list is re-read, then render with it.
let bustCounter = 0;
export function nextBust() {
  return ++bustCounter;
}
export function bustedSrc(path: string, token: number) {
  return `${convertFileSrc(path)}?t=${token}`;
}

// What the grid should render once retention has pruned underneath it. The
// `screenshot-pruned` event carries only a count, so a fresh listing is the
// only authority on which paths went. Entries the grid still holds keep their
// position (the user may be scrolled into the page); anything the listing has
// that the grid does not — a capture that raced the prune — goes on top, which
// is where `screenshot_list`'s newest-first order puts it.
export function afterPrune(current: string[], surviving: string[]): string[] {
  const alive = new Set(surviving);
  const held = new Set(current);
  return [...surviving.filter((p) => !held.has(p)), ...current.filter((p) => alive.has(p))];
}

// Same event, seen from a component that pins ONE shot. Retention only ever
// protects the newest file on disk, so the pinned path is fair game: the thumb
// follows crops and gallery picks, and neither is guaranteed to still be
// newest. Keep the pin if it survived, else fall back to the newest survivor,
// else nothing left to show.
export function pinnedAfterPrune(current: string | null, surviving: string[]): string | null {
  if (current && surviving.includes(current)) return current;
  return surviving[0] ?? null;
}

// A dblclick is delivered as click, click, dblclick — so a grid that copies on
// click and crops on double-click raised two copy toasts before the editor even
// opened. Hold the single-click action for one double-click interval; the
// second click of a pair is swallowed and the dblclick cancels the timer.
// Keyed by path so two thumbs clicked in quick succession do not cancel each
// other.
export const DBL_CLICK_MS = 250;

export interface ClickGuard {
  click: (key: string, run: () => void) => void;
  doubleClick: (key: string, run: () => void) => void;
  cancelAll: () => void;
}

export function makeClickGuard(delay = DBL_CLICK_MS): ClickGuard {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    click(key, run) {
      if (pending.has(key)) return; // second click of a double click
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          run();
        }, delay),
      );
    },
    doubleClick(key, run) {
      const id = pending.get(key);
      if (id !== undefined) {
        clearTimeout(id);
        pending.delete(key);
      }
      run();
    },
    cancelAll() {
      for (const id of pending.values()) clearTimeout(id);
      pending.clear();
    },
  };
}

// Retention policy mirror of the Rust `Retention` struct (screenshot.rs).
// 0 = that limit is off.
interface Retention {
  maxCount: number;
  maxMb: number;
}

interface Props {
  onClose: () => void;
  // Called when the newest shot changes under us (delete of the current one, or
  // a crop saved from the gallery) so the pinned thumb can follow along.
  // `null` means there is no shot left — deleting the last one has to clear the
  // thumb, or it keeps rendering the deleted path as a broken image.
  onPicked?: (path: string | null) => void;
}

export default function ScreenshotGallery({ onClose, onPicked }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [cropping, setCropping] = useState<string | null>(null);
  const [retention, setRetention] = useState<Retention | null>(null);
  // Bumped every time the list is re-read so each <img> re-fetches: a crop
  // saved over an existing path leaves the cached pixels otherwise.
  const [stamp, setStamp] = useState(nextBust);
  const backdrop = useBackdropClose(onClose);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      setPaths(await screenshotList());
      setStamp(nextBust());
    } catch {
      /* no Tauri / folder unreadable */
    }
  }, []);

  // One guard for the whole grid; a ref so the pending timers survive renders.
  const clicksRef = useRef<ClickGuard | null>(null);
  if (!clicksRef.current) clicksRef.current = makeClickGuard();
  const clicks = clicksRef.current;
  useEffect(() => () => clicks.cancelAll(), [clicks]);

  // What is in the two number inputs right now, as typed. Kept apart from
  // `retention` (the committed policy) because the committed one is enforced by
  // deleting files: typing 500 over 200 passes through "5", and a policy of
  // "keep 5" would have destroyed 195 shots before the third keystroke.
  const [draft, setDraft] = useState<{ maxCount: string; maxMb: string } | null>(null);
  const asDraft = (r: Retention) => ({ maxCount: String(r.maxCount), maxMb: String(r.maxMb) });

  useEffect(() => {
    if (!isTauri) return;
    invoke<Retention>("screenshot_retention_get")
      .then((r) => {
        setRetention(r);
        setDraft(asDraft(r));
      })
      .catch(() => {});
  }, []);

  // Persist + apply immediately: the backend prunes on save and tells us how
  // many files that policy just deleted. Only ever called from commitDraft —
  // pruning is irreversible, so a half-typed number must never reach it.
  const saveRetention = async (next: Retention) => {
    setRetention(next);
    setDraft(asDraft(next));
    try {
      const removed = (await invoke("screenshot_retention_set", { retention: next })) as number;
      if (removed > 0) {
        useLayout.getState().addToast(`Retention removed ${removed} screenshot${removed === 1 ? "" : "s"}`);
        await refresh();
      }
    } catch (err) {
      useLayout.getState().addToast(`Retention save failed: ${err}`);
    }
  };

  // Commit one field on blur or Enter — never on keystroke. A blank or junk
  // entry snaps back to the committed value rather than being read as 0 ("no
  // limit") or as some prefix of what the user was still typing.
  const commitDraft = (field: keyof Retention) => {
    if (!retention || !draft) return;
    const raw = draft[field].trim();
    const n = Math.floor(Number(raw));
    if (raw === "" || !Number.isFinite(n) || n < 0) {
      setDraft(asDraft(retention));
      return;
    }
    if (n === retention[field]) {
      setDraft(asDraft(retention)); // normalise "007" → "7"
      return;
    }
    void saveRetention({ ...retention, [field]: n });
  };

  useEffect(() => {
    void refresh();
    const onTaken = () => void refresh();
    window.addEventListener(SHOT_TAKEN_EVENT, onTaken);
    return () => window.removeEventListener(SHOT_TAKEN_EVENT, onTaken);
  }, [refresh]);

  // Retention prunes on the capture path, which is a global hotkey — it can
  // delete files out from under an open grid, which then keeps rendering them
  // as broken images. Re-list and drop whatever went.
  useEffect(() => {
    if (!isTauri) return;
    const un = listen("screenshot-pruned", () => {
      void screenshotList()
        .then((surviving) => {
          setPaths((cur) => afterPrune(cur, surviving));
          setStamp(nextBust());
        })
        .catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Esc closes; the crop editor owns the key while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cropping) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cropping, onClose]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openFolder = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch {
      try {
        // Tauri plugin, not navigator.clipboard — WebView2 drops navigator
        // writes without focus (same rule as ScreenshotThumb).
        await clipboardWriteText(path);
        useLayout.getState().addToast("Screenshot path copied");
      } catch {
        /* clipboard unavailable */
      }
    }
  };

  const copyImage = async (path: string) => {
    try {
      const bytes = (await invoke("screenshot_read_png", { path })) as number[];
      await writeImage(new Uint8Array(bytes));
      useLayout.getState().addToast("Screenshot copied");
    } catch {
      try {
        await clipboardWriteText(path);
        useLayout.getState().addToast("Screenshot path copied");
      } catch {
        /* clipboard unavailable */
      }
    }
  };

  const ocr = async (path: string) => {
    try {
      const text = (await invoke("screenshot_ocr", { path })) as string;
      if (!text.trim()) {
        useLayout.getState().addToast("OCR found no text");
        return;
      }
      await clipboardWriteText(text);
      const lines = text.split("\n").length;
      useLayout.getState().addToast(`OCR copied (${lines} line${lines === 1 ? "" : "s"})`);
    } catch (err) {
      useLayout.getState().addToast(`OCR failed: ${err}`);
    }
  };

  const del = async (path: string) => {
    try {
      await invoke("screenshot_delete", { path });
      const next = await screenshotList();
      setPaths(next);
      setStamp(nextBust());
      // Always report, including the empty case: `next[0]` is undefined when the
      // last shot goes, and skipping the call left the thumb on a dead path.
      onPicked?.(next[0] ?? null);
      useLayout.getState().addToast("Screenshot deleted");
    } catch (err) {
      useLayout.getState().addToast(`Delete failed: ${err}`);
    }
  };

  const menuItems = (path: string): { label: string; run: () => void }[] => [
    { label: "Crop / Snip", run: () => setCropping(path) },
    { label: "OCR → copy text", run: () => void ocr(path) },
    { label: "Copy", run: () => void copyImage(path) },
    { label: "Open folder", run: () => void openFolder(path) },
    { label: "Delete", run: () => void del(path) },
  ];

  const page = paths.slice(0, shown);
  const hidden = paths.length - page.length;

  return (
    <>
      {cropping && (
        <ScreenshotCrop
          src={convertFileSrc(cropping)}
          onClose={() => setCropping(null)}
          onSaved={(p) => {
            onPicked?.(p);
            void refresh();
          }}
        />
      )}
      {menu && (
        <div
          role="menu"
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            zIndex: 131,
            minWidth: 148,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 4,
            boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
          }}
        >
          {menuItems(menu.path).map((it) => (
            <button
              key={it.label}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                fontSize: 12,
                background: "transparent",
                color: it.label === "Delete" ? "#f87171" : "var(--text)",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
      <div style={overlay} {...backdrop}>
        <div
          style={{
            width: 760,
            maxWidth: "92vw",
            height: 520,
            maxHeight: "88vh",
            display: "flex",
            flexDirection: "column",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text)" }}>
              Screenshots{" "}
              <span style={{ color: "var(--muted)" }}>
                ({paths.length}
                {hidden > 0 ? `, showing ${page.length}` : ""})
              </span>
            </div>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                color: "var(--muted)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "3px 9px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {page.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>
                No screenshots yet.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                  gap: 10,
                }}
              >
                {page.map((path) => (
                  <div
                    key={path}
                    title={`${baseName(path)}\nClick to copy the image · double-click to crop · drag out to drop the path · right-click for menu`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const MENU_W = 156;
                      const MENU_H = 5 * 30 + 8; // 5 rows + container padding
                      let x = e.clientX;
                      let y = e.clientY;
                      if (x + MENU_W > window.innerWidth) x = window.innerWidth - MENU_W - 4;
                      if (y + MENU_H > window.innerHeight) y = e.clientY - MENU_H;
                      setMenu({ x: Math.max(4, x), y: Math.max(4, y), path });
                    }}
                    style={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      padding: 4,
                    }}
                  >
                    <img
                      src={bustedSrc(path, stamp)}
                      alt={baseName(path)}
                      loading="lazy"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", path);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => clicks.click(path, () => void copyImage(path))}
                      onDoubleClick={() => clicks.doubleClick(path, () => setCropping(path))}
                      style={{
                        display: "block",
                        width: "100%",
                        height: 96,
                        objectFit: "cover",
                        borderRadius: 5,
                        cursor: "pointer",
                      }}
                    />
                    {/* Click-copies / double-click-crops used to be invisible:
                        the only hint was the tooltip. Spell it out under every
                        thumb — the toast then confirms the copy landed. */}
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 10,
                        color: "var(--muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {baseName(path)}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--muted)", opacity: 0.75 }}>
                      click = copy · dbl = crop
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hidden > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "8px 14px",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {hidden} older screenshot{hidden === 1 ? "" : "s"} not rendered
              </span>
              <button
                onClick={() => setShown((n) => n + PAGE)}
                style={{
                  background: "var(--panel-2)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  padding: "4px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Load {Math.min(PAGE, hidden)} more
              </button>
            </div>
          )}

          {/* Retention. The folder is next to the exe and captures land on a
              global hotkey, so without a cap it grows forever. 0 = off. */}
          {retention && draft && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                borderTop: "1px solid var(--border)",
                fontSize: 11,
                color: "var(--muted)",
              }}
            >
              <span>Keep newest</span>
              <input
                type="number"
                min={0}
                placeholder="200"
                title="Applied when you leave the field or press Enter"
                value={draft.maxCount}
                onChange={(e) => setDraft({ ...draft, maxCount: e.target.value })}
                onBlur={() => commitDraft("maxCount")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitDraft("maxCount");
                  if (e.key === "Escape") {
                    // Revert the field instead of closing the gallery.
                    e.stopPropagation();
                    setDraft(asDraft(retention));
                  }
                }}
                style={numStyle}
              />
              <span>shots ·</span>
              <input
                type="number"
                min={0}
                placeholder="500"
                title="Applied when you leave the field or press Enter"
                value={draft.maxMb}
                onChange={(e) => setDraft({ ...draft, maxMb: e.target.value })}
                onBlur={() => commitDraft("maxMb")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitDraft("maxMb");
                  if (e.key === "Escape") {
                    // Revert the field instead of closing the gallery.
                    e.stopPropagation();
                    setDraft(asDraft(retention));
                  }
                }}
                style={numStyle}
              />
              <span>MB total</span>
              <span style={{ marginLeft: "auto", opacity: 0.8 }}>
                0 = no limit · Enter to apply
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
