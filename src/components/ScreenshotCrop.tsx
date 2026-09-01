// Post-capture snip/crop editor. Opened from the screenshot thumbnail; loads a
// saved PNG into a canvas, lets you drag-select a rectangle, then either saves
// the cropped region as a new PNG in the app's data/ folder (Rust `screenshot_save_crop`)
// or copies it to the clipboard. Frontend does the cropping; the backend only
// writes the finished bytes so the portable screenshots/ folder stays the sole
// source of truth.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useLayout } from "../stores/layout";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  // Source image: what the <img>/thumb already shows (data: or asset url). The
  // crop is derived entirely from these bytes; no on-disk path is needed here.
  src: string;
  onClose: () => void;
  // Called with the freshly written crop path so the thumb can refresh to it.
  onSaved?: (path: string) => void;
}

interface Rect { x: number; y: number; w: number; h: number }

// Crop a loaded image element to a natural-pixel rect, returning PNG bytes.
async function cropToPng(img: HTMLImageElement, r: Rect): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(r.w));
  c.height = Math.max(1, Math.round(r.h));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const blob: Blob = await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

export default function ScreenshotCrop({ src, onClose, onSaved }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [sel, setSel] = useState<Rect | null>(null); // in displayed (CSS) px
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Preload the source into an off-DOM element at natural resolution so the
  // crop keeps full quality regardless of how small the preview is shown.
  useEffect(() => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => setImg(el);
    el.src = src;
  }, [src]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const localPoint = (e: React.PointerEvent) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(e.clientY - rect.top, 0), rect.height),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!imgRef.current) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    dragStart.current = p;
    setSel({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const s = dragStart.current;
    const p = localPoint(e);
    setSel({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };
  const onUp = () => {
    dragStart.current = null;
    setSel((s) => (s && (s.w < 3 || s.h < 3) ? null : s)); // ignore stray clicks
  };

  // Map the displayed selection to natural pixels for the actual crop.
  const naturalRect = (): Rect | null => {
    if (!sel || !img || !imgRef.current) return null;
    const disp = imgRef.current.getBoundingClientRect();
    const sx = img.naturalWidth / disp.width;
    const sy = img.naturalHeight / disp.height;
    return { x: sel.x * sx, y: sel.y * sy, w: sel.w * sx, h: sel.h * sy };
  };

  const doSave = async () => {
    const r = naturalRect();
    if (!r || !img) return;
    setBusy(true);
    try {
      const png = await cropToPng(img, r);
      const saved = (await invoke("screenshot_save_crop", {
        png: Array.from(png),
      })) as string;
      useLayout.getState().addToast("Crop saved");
      onSaved?.(saved);
      onClose();
    } catch (err) {
      useLayout.getState().addToast(`Crop save failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    const r = naturalRect();
    if (!r || !img) return;
    setBusy(true);
    try {
      const png = await cropToPng(img, r);
      await writeImage(png);
      useLayout.getState().addToast("Crop copied");
      onClose();
    } catch (err) {
      useLayout.getState().addToast(`Crop copy failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const hasSel = !!sel && sel.w >= 3 && sel.h >= 3;
  const btn: React.CSSProperties = {
    padding: "6px 12px",
    fontSize: 12,
    background: "var(--panel-2)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 130, // above the thumb (118) and dialogs (115)
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 12,
          maxWidth: "92vw",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          Drag on the image to select a region, then Save or Copy.
        </div>
        <div
          ref={wrapRef}
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 6,
            lineHeight: 0,
            touchAction: "none",
            cursor: "crosshair",
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt="screenshot to crop"
            draggable={false}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            style={{
              display: "block",
              maxWidth: "88vw",
              maxHeight: "76vh",
              userSelect: "none",
            }}
          />
          {sel && (
            <div
              style={{
                position: "absolute",
                left: sel.x,
                top: sel.y,
                width: sel.w,
                height: sel.h,
                border: "1px solid var(--accent)",
                background: "rgba(76,139,245,0.15)",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--muted)", marginRight: "auto" }}>
            {img ? `${img.naturalWidth}×${img.naturalHeight}` : "loading…"}
          </span>
          <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btn} onClick={doCopy} disabled={busy || !hasSel}>Copy</button>
          <button
            style={{ ...btn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}
            onClick={doSave}
            disabled={busy || !hasSel || !isTauri}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
