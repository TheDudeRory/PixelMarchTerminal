// Dismiss-on-backdrop-click for modal overlays. Plain `onClick` on the overlay
// closes the modal even when a drag (e.g. text selection) starts inside the
// dialog and the mouse is released over the backdrop — the browser dispatches
// the click on the common ancestor. Close only when the press ALSO started on
// the overlay itself.
import { useRef, type MouseEvent } from "react";

export function useBackdropClose(onClose: () => void) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown: (e: MouseEvent) => { downOnBackdrop.current = e.target === e.currentTarget; },
    onClick: (e: MouseEvent) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); },
  };
}
