/**
 * The presenter: the talk in a Remotion Player, one step per key press.
 *
 *   → / PageDown / Space   play the next step (it stops at its end)
 *   ← / PageUp             back one step
 *   R                      replay this step
 *   N                      show / hide the notes
 *   F                      fullscreen, video only (for recording)
 *
 * The step lives in the URL hash, so a reload lands on the same step.
 */
import { Player, type PlayerRef } from "@remotion/player";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ranges, steps, totalFrames } from "./steps.ts";
import { Talk } from "./Talk.tsx";
import { VIDEO } from "./theme.ts";

const fromHash = () =>
  Math.min(steps.length - 1, Math.max(0, Number(location.hash.slice(1)) - 1 || 0));

function App() {
  const player = useRef<PlayerRef>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(fromHash);
  const [notes, setNotes] = useState(true);
  /** The frame the current step stops on while it plays. */
  const stopAt = useRef<number | null>(null);

  /** Play step `i` from its start, or show its last frame. */
  const show = useCallback((i: number, play: boolean) => {
    const p = player.current;
    const next = Math.min(steps.length - 1, Math.max(0, i));
    setIndex(next);
    history.replaceState(null, "", `#${next + 1}`);
    if (!p) return;
    const { from, to } = ranges[next]!;
    if (play) {
      stopAt.current = to - 1;
      p.seekTo(from);
      p.play();
    } else {
      stopAt.current = null;
      p.pause();
      p.seekTo(to - 1);
    }
  }, []);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    show(index, false);
    const onFrame = (e: { detail: { frame: number } }) => {
      if (stopAt.current !== null && e.detail.frame >= stopAt.current) {
        const end = stopAt.current;
        stopAt.current = null;
        p.pause();
        p.seekTo(end);
      }
    };
    p.addEventListener("frameupdate", onFrame);
    return () => p.removeEventListener("frameupdate", onFrame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          show(index + 1, true);
          break;
        case "ArrowLeft":
        case "PageUp":
          show(index - 1, false);
          break;
        case "r":
          show(index, true);
          break;
        case "n":
          setNotes((v) => !v);
          break;
        case "f":
          if (document.fullscreenElement) document.exitFullscreen();
          else stage.current?.requestFullscreen();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, show]);

  const step = steps[index]!;
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: notes ? "minmax(0,1fr) auto" : "1fr",
      }}
    >
      <div
        ref={stage}
        style={{ minHeight: 0, display: "grid", placeItems: "center", background: "#000" }}
      >
        <Player
          ref={player}
          component={Talk}
          durationInFrames={totalFrames}
          fps={VIDEO.fps}
          compositionWidth={VIDEO.width}
          compositionHeight={VIDEO.height}
          moveToBeginningWhenEnded={false}
          style={{ width: "100%", maxHeight: "100%", aspectRatio: "16 / 9" }}
          acknowledgeRemotionLicense
        />
      </div>
      {notes && (
        <div
          style={{
            padding: "14px 24px 18px",
            borderTop: "1px solid #2e2922",
            fontSize: 17,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: "#a89572", fontSize: 13, marginBottom: 6 }}>
            {index + 1} / {steps.length} · → next · ← back · R replay · N notes · F fullscreen
          </div>
          {step.notes}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
