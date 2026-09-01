// Per-monitor snip overlay. The screenshot backend opens one borderless,
// always-on-top window per monitor (label `snip-<idx>`, url index.html?snip=1),
// sized to cover that monitor and showing the PNG it just captured for it.
//
// Drag a region  -> crops those pixels, saves a new PNG in the app's data/ folder, and
//                   closes EVERY overlay (the shot is taken).
// Esc / right-click -> closes EVERY overlay too: snipping is skipped outright.
// The full-monitor PNGs are already on disk either way, so skipping everything
// still leaves the last capture in the bottom-left thumbnail.
import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface Rect { x: number; y: number; w: number; h: number }

// Crop a loaded image to a natural-pixel rect, returning PNG bytes.
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

export default function SnipWindow() {
  const [src, setSrc] = useState<string | null>(null);
  const [sel, setSel] = useState<Rect | null>(null); // CSS px within the window
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Off-DOM copy of the shot, fetched with CORS so the crop canvas is NOT
  // tainted. The on-screen <img> alone can't be used as a canvas source: an
  // asset:// image loaded without crossOrigin taints the canvas and toBlob
  // throws SecurityError (that's why early snips silently saved nothing).
  const [srcImg, setSrcImg] = useState<HTMLImageElement | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Which PNG this overlay shows is keyed off the window label, backend side.
  useEffect(() => {
    invoke<string>("snip_source")
      .then((p) => {
        const url = convertFileSrc(p);
        setSrc(url);
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => setSrcImg(el);
        el.onerror = () => setError("could not load the capture for cropping");
        el.src = url;
      })
      .catch(() => invoke("snip_close_all").catch(() => {}));
  }, []);

  // Esc dismisses the whole set of overlays, not just this monitor's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        invoke("snip_close_all").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const point = (e: React.PointerEvent) => ({
    x: Math.min(Math.max(e.clientX, 0), window.innerWidth),
    y: Math.min(Math.max(e.clientY, 0), window.innerHeight),
  });

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = point(e);
    dragStart.current = p;
    setSel({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const s = dragStart.current;
    const p = point(e);
    setSel({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };

  const onUp = async () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    const r = sel;
    // Stray click, not a drag: leave the overlay up so the user can try again.
    if (!r || r.w < 4 || r.h < 4 || !srcImg || busy) {
      setSel(null);
      return;
    }
    setBusy(true);
    try {
      // The <img> fills the window; map CSS px back to the PNG's own pixels
      // (they differ whenever the monitor has a scale factor).
      const sx = srcImg.naturalWidth / (imgRef.current?.clientWidth || window.innerWidth);
      const sy = srcImg.naturalHeight / (imgRef.current?.clientHeight || window.innerHeight);
      const png = await cropToPng(srcImg, {
        x: r.x * sx,
        y: r.y * sy,
        w: r.w * sx,
        h: r.h * sy,
      });
      // Saved crop broadcasts `screenshot-taken`, so the main window's thumb
      // switches to the snip before the overlays disappear.
      await invoke("screenshot_save_crop", { png: Array.from(png) });
    } catch (err) {
      // Keep the overlay up and say what went wrong — a silently dropped snip
      // looks exactly like a working one.
      console.error("snip failed", err);
      setError(String(err));
      setSel(null);
      setBusy(false);
      return;
    }
    setBusy(false);
    invoke("snip_close_all").catch(() => {});
  };

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={(e) => {
        e.preventDefault();
        invoke("snip_close_all").catch(() => {});
      }}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        cursor: "crosshair",
        userSelect: "none",
        touchAction: "none",
        background: "#000",
      }}
    >
      {src && (
        <img
          ref={imgRef}
          src={src}
          alt=""
          crossOrigin="anonymous"
          draggable={false}
          style={{ display: "block", width: "100vw", height: "100vh", objectFit: "fill" }}
        />
      )}
      {/* Dim everything outside the selection; before any drag the whole shot
          dims slightly so it's obvious an overlay is up. */}
      <div
        style={{
          position: "absolute",
          left: sel?.x ?? 0,
          top: sel?.y ?? 0,
          width: sel?.w ?? 0,
          height: sel?.h ?? 0,
          border: sel ? "1px solid #4c8bf5" : "none",
          boxShadow: `0 0 0 9999px rgba(0,0,0,${sel ? 0.45 : 0.25})`,
          pointerEvents: "none",
        }}
      />
      {error && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 64,
            transform: "translateX(-50%)",
            maxWidth: "80vw",
            padding: "6px 14px",
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            color: "#fca5a5",
            background: "rgba(30,10,10,0.9)",
            border: "1px solid rgba(255,120,120,0.35)",
            borderRadius: 8,
            pointerEvents: "none",
          }}
        >
          Snip failed: {error}
        </div>
      )}
      {!sel && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 24,
            transform: "translateX(-50%)",
            padding: "6px 14px",
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            color: "#e6e6e6",
            background: "rgba(20,20,24,0.85)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            pointerEvents: "none",
          }}
        >
          Drag to snip · Esc to skip
        </div>
      )}
      {sel && sel.w >= 4 && sel.h >= 4 && (
        <div
          style={{
            position: "absolute",
            left: sel.x,
            top: Math.max(0, sel.y - 22),
            fontSize: 12,
            fontFamily: "system-ui, sans-serif",
            color: "#e6e6e6",
            background: "rgba(20,20,24,0.85)",
            padding: "1px 6px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          {Math.round(sel.w)}×{Math.round(sel.h)}
        </div>
      )}
    </div>
  );
}
