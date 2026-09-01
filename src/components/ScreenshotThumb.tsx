// Newest-screenshot thumbnail, pinned bottom-left above the panes. Drag it
// into any window that accepts text and it drops the shot's full path;
// click reveals the file in Explorer (falls back to copying the path).
// Double-click or the right-click menu opens the snip/crop editor.
import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText as clipboardWriteText, writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { screenshotList, screenshotProtect } from "../lib/ipc";
import { SHOT_TAKEN_EVENT, type ShotTakenDetail } from "./ScreenshotOverlay";
import { useLayout } from "../stores/layout";
import ScreenshotCrop from "./ScreenshotCrop";
import ScreenshotGallery, {
  bustedSrc,
  makeClickGuard,
  nextBust,
  pinnedAfterPrune,
  type ClickGuard,
} from "./ScreenshotGallery";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function baseName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

// One src for a freshly re-saved shot. The counter and the guard live in
// ScreenshotGallery so the grid and this thumb bust the same way.
const rebusted = (path: string) => bustedSrc(path, nextBust());

export default function ScreenshotThumb() {
  const [shot, setShot] = useState<{ path: string; src: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    screenshotList()
      .then((paths) => {
        // Newest first; a snip modified after its source wins naturally.
        if (paths[0]) setShot({ path: paths[0], src: convertFileSrc(paths[0]) });
      })
      .catch(() => {});
    const onTaken = (e: Event) => {
      const { path, base64 } = (e as CustomEvent<ShotTakenDetail>).detail;
      setShot({ path, src: base64 ? `data:image/png;base64,${base64}` : convertFileSrc(path) });
      setHidden(false);
      // No editor here anymore: snipping happens in the per-monitor overlays
      // (SnipWindow.tsx) right after the capture. The thumb just shows whatever
      // landed last — the snip if one was taken, else the last monitor's shot.
    };
    window.addEventListener(SHOT_TAKEN_EVENT, onTaken);
    return () => window.removeEventListener(SHOT_TAKEN_EVENT, onTaken);
  }, []);

  // Retention deletes on the capture path, which is a global hotkey — without
  // this the folder just quietly shrinks. The backend only emits when it
  // actually removed something, so a policy of "off" is silent.
  useEffect(() => {
    if (!isTauri) return;
    const un = listen<{ removed: number }>("screenshot-pruned", (e) => {
      const n = e.payload.removed;
      useLayout.getState().addToast(`Retention removed ${n} old screenshot${n === 1 ? "" : "s"}`);
      // The prune protects only the newest file on disk, and the shot pinned
      // here is not always the newest — it follows crops and gallery picks. If
      // retention just deleted it, step to the newest survivor instead of
      // rendering a path that is gone.
      void screenshotList()
        .then((surviving) => {
          setShot((cur) => {
            const next = pinnedAfterPrune(cur?.path ?? null, surviving);
            if (next === (cur?.path ?? null)) return cur;
            return next ? { path: next, src: rebusted(next) } : null;
          });
        })
        .catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // The pinned shot is not always the newest on disk (it follows crops and
  // gallery picks), yet retention only protects the newest. Tell the backend to
  // exempt whatever is pinned here so a pinned older shot survives a prune — the
  // frontend half of bug 4. This is the ONE owner of the protected set (a REPLACE
  // per call), so keying it on the pinned path alone covers every change route:
  // initial load, a new capture, a crop, a gallery pick, and the prune reconcile.
  useEffect(() => {
    if (!isTauri) return;
    void screenshotProtect(shot ? [shot.path] : []).catch(() => {});
  }, [shot?.path]);

  // Click reveals in the file manager, double-click crops — but the DOM sends
  // two clicks before a dblclick, so a crop used to open two Explorer windows
  // first. Same guard the gallery grid uses.
  const clicksRef = useRef<ClickGuard | null>(null);
  if (!clicksRef.current) clicksRef.current = makeClickGuard();
  const clicks = clicksRef.current;
  useEffect(() => () => clicks.cancelAll(), [clicks]);

  // Close the context menu on any outside click while it's open.
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

  // The thumb is position:fixed over the sidebar's bottom-left corner, so the
  // sidebar needs to know when it is up to keep the SWARMS separator clear.
  const onScreen = !!shot && !hidden;
  useEffect(() => {
    useLayout.getState().setShotThumbVisible(onScreen);
  }, [onScreen]);

  // The history panel outlives the thumb: it stays up after the last shot is
  // deleted, and while the thumb is hidden.
  const galleryEl = gallery ? (
    <ScreenshotGallery
      onClose={() => setGallery(false)}
      // null = the gallery deleted the last shot; drop the thumb instead of
      // leaving it pointed at a file that no longer exists.
      onPicked={(p) => setShot(p ? { path: p, src: rebusted(p) } : null)}
    />
  ) : null;

  if (!shot || hidden) return galleryEl;

  const openFolder = async () => {
    try {
      await revealItemInDir(shot.path);
    } catch {
      try {
        // Tauri plugin, not navigator.clipboard — WebView2 silently drops
        // navigator writes without focus/permission (same rule as terminalPool).
        await clipboardWriteText(shot.path);
        useLayout.getState().addToast("Screenshot path copied");
      } catch {
        /* clipboard unavailable */
      }
    }
  };

  const copyImage = async () => {
    try {
      // Read the PNG off disk (portable folder) and push it to the clipboard as
      // an image, not just its path.
      const bytes = (await invoke("screenshot_read_png", { path: shot.path })) as number[];
      await writeImage(new Uint8Array(bytes));
      useLayout.getState().addToast("Screenshot copied");
    } catch {
      // Fall back to copying the path if image clipboard is unavailable.
      try {
        await clipboardWriteText(shot.path);
        useLayout.getState().addToast("Screenshot path copied");
      } catch {
        /* clipboard unavailable */
      }
    }
  };

  // Read the text out of the shot and put it on the clipboard: pasting an error
  // as text costs a fraction of what handing an agent the image does.
  const ocr = async () => {
    try {
      const text = (await invoke("screenshot_ocr", { path: shot.path })) as string;
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

  const del = async () => {
    try {
      await invoke("screenshot_delete", { path: shot.path });
      // Show the next newest, if any.
      const paths = await screenshotList();
      if (paths[0]) setShot({ path: paths[0], src: rebusted(paths[0]) });
      else setShot(null);
      useLayout.getState().addToast("Screenshot deleted");
    } catch (err) {
      useLayout.getState().addToast(`Delete failed: ${err}`);
    }
  };

  const menuItems: { label: string; run: () => void }[] = [
    { label: "Crop / Snip", run: () => setCropping(true) },
    { label: "History…", run: () => setGallery(true) },
    { label: "OCR → copy text", run: ocr },
    { label: "Copy", run: copyImage },
    { label: "Open folder", run: openFolder },
    { label: "Delete", run: del },
  ];

  return (
    <>
    {galleryEl}
    {cropping && (
      <ScreenshotCrop
        src={shot.src}
        onClose={() => setCropping(false)}
        onSaved={(p) => setShot({ path: p, src: rebusted(p) })}
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
        {menuItems.map((it) => (
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
    <div
      title={`${baseName(shot.path)}\nClick to reveal in the file manager · double-click to crop · drag out to drop the path · right-click for menu`}
      onContextMenu={(e) => {
        e.preventDefault();
        // Thumb is pinned bottom-left, so a raw clientY opens the menu downward
        // into (or behind) the taskbar. Clamp to the viewport: flip above the
        // cursor when it would overflow the bottom, shift left off the right.
        const MENU_W = 156;
        const MENU_H = menuItems.length * 30 + 8; // ~30px/row + container padding
        let x = e.clientX;
        let y = e.clientY;
        if (x + MENU_W > window.innerWidth) x = window.innerWidth - MENU_W - 4;
        if (y + MENU_H > window.innerHeight) y = e.clientY - MENU_H;
        setMenu({ x: Math.max(4, x), y: Math.max(4, y) });
      }}
      // Above the modal dialogs (115) so it stays draggable into their inputs
      // (e.g. the swarm mission box), below the palette (120).
      style={{ position: "fixed", left: 10, bottom: 10, zIndex: 118, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 4, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}
    >
      <img
        src={shot.src}
        alt={baseName(shot.path)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", shot.path);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => clicks.click(shot.path, () => void openFolder())}
        onDoubleClick={() => clicks.doubleClick(shot.path, () => setCropping(true))}
        style={{ display: "block", width: 148, maxHeight: 96, objectFit: "cover", borderRadius: 5, cursor: "pointer" }}
      />
      <button
        onClick={() => setHidden(true)}
        title="Hide until next screenshot"
        style={{ position: "absolute", top: -7, right: -7, width: 18, height: 18, lineHeight: "16px", padding: 0, fontSize: 11, background: "var(--panel-2)", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "50%", cursor: "pointer" }}
      >
        ×
      </button>
    </div>
    </>
  );
}
