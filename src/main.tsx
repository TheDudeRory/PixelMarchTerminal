import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import VoiceWindow from "./components/VoiceWindow";
import SnipWindow from "./components/SnipWindow";
import { installPerfProbe } from "./lib/perfProbe";
import "./index.css";

// `window.__perf` — the frame/longtask meter. It was written to measure the
// render tiering against a REAL webview with real PTYs behind it and was never
// actually installed, so the only numbers it could ever produce came from the
// vitest bench. Installing costs nothing until something calls start(): the
// probe allocates no timers and observes nothing until then.
installPerfProbe();

// This bundle is loaded by three kinds of window, told apart by query string:
//   ?voice=1 — the compact voice pill
//   ?snip=1  — a per-monitor snip overlay (one per display, after a capture)
//   (none)   — the full terminal manager
const params = new URLSearchParams(window.location.search);
const isVoiceWindow = params.get("voice") === "1";
const isSnipWindow = params.get("snip") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSnipWindow ? <SnipWindow /> : isVoiceWindow ? <VoiceWindow /> : <App />}
  </React.StrictMode>,
);
