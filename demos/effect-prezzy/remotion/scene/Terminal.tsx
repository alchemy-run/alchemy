import { Freeze, OffthreadVideo, staticFile } from "remotion";
import { TERMINAL, TITLE_BAR, type SceneCapture, type TerminalTab } from "../../shared/types.ts";
import { mono, sans } from "../fonts.ts";
import { TrafficLights, Window } from "./Desktop.tsx";
import type { SceneSchedule } from "./schedule.ts";

/** tcut's `dark-modern` background, so the clip blends into the window. */
const BACKGROUND = "#1f1f1f";
const BAR = "#161616";

const TAB_LABELS: Record<TerminalTab, string> = {
  shell: "deploy & test",
  dev: "alchemy dev",
};

/** Position in the terminal clip at `frame`: plays during terminal beats, holds between them. */
const clipTime = (plan: SceneSchedule, frame: number, fps: number): number => {
  let time: number | undefined;
  for (const segment of plan.segments) {
    const { beat } = segment;
    if (beat.kind !== "terminal") continue;
    if (segment.from > frame) {
      // Before the first terminal beat: its opening frame (a fresh prompt).
      time ??= beat.start;
      break;
    }
    const elapsed = Math.max(0, frame - segment.from - segment.switchFrames) / fps;
    time = Math.min(beat.start + elapsed, beat.end);
  }
  return time ?? 0;
};

/** The tabs open and the one on screen at clip time `time`. */
const tabsAt = (capture: SceneCapture, time: number) => {
  const open: TerminalTab[] = [...(capture.start.terminalTabs ?? ["shell"])];
  let active: TerminalTab = capture.terminal?.tabs[0]?.tab ?? "shell";
  for (const change of capture.terminal?.tabs ?? []) {
    // A tab switch shows up a frame before the clip repaints; lead by a hair.
    if (change.at > time + 0.05) break;
    active = change.tab;
    if (!open.includes(change.tab)) open.push(change.tab);
  }
  return { open, active };
};

const TabStrip = ({ open, active }: { open: TerminalTab[]; active: TerminalTab }) => (
  <div
    style={{
      height: TITLE_BAR,
      flex: "none",
      display: "flex",
      alignItems: "stretch",
      background: BAR,
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      fontFamily: sans,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", padding: "0 18px", flex: "none" }}>
      <TrafficLights />
    </div>
    {open.map((tab) => {
      const selected = tab === active;
      return (
        <div
          key={tab}
          style={{
            width: 280,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            background: selected ? BACKGROUND : "transparent",
            borderLeft: "1px solid rgba(255,255,255,0.06)",
            borderRight: "1px solid rgba(255,255,255,0.06)",
            color: selected ? "#e6e6e6" : "#8a8a8a",
            fontSize: 15,
            fontWeight: selected ? 600 : 500,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 12,
              color: selected ? "#a3c473" : "#6b6b6b",
            }}
          >
            {tab === "dev" ? "●" : "❯"}
          </span>
          {TAB_LABELS[tab]}
        </div>
      );
    })}
    <div style={{ flex: 1 }} />
    <div style={{ display: "flex", alignItems: "center", padding: "0 20px", color: "#6b6b6b", fontSize: 14 }}>
      ~/shorty
    </div>
  </div>
);

export const Terminal = ({
  capture,
  plan,
  frame,
  fps,
}: {
  capture: SceneCapture;
  plan: SceneSchedule;
  frame: number;
  fps: number;
}) => {
  const time = clipTime(plan, frame, fps);
  const { open, active } = tabsAt(capture, time);
  // Stay one frame inside the clip so the last frame is always decodable.
  const last = capture.terminal ? Math.max(0, Math.floor(capture.terminal.duration * fps) - 1) : 0;
  const videoFrame = Math.min(Math.round(time * fps), last);
  return (
    <Window background={BACKGROUND} bar={<TabStrip open={open} active={active} />}>
      {capture.terminal ? (
        <Freeze frame={videoFrame}>
          <OffthreadVideo
            src={staticFile(capture.terminal.clip)}
            muted
            style={{ width: TERMINAL.width, height: TERMINAL.height, display: "block" }}
          />
        </Freeze>
      ) : null}
    </Window>
  );
};
