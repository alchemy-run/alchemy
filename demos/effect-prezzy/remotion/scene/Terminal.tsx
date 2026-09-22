import { Freeze, OffthreadVideo, staticFile } from "remotion";
import { TERMINAL, type SceneCapture } from "../../shared/types.ts";
import { Window } from "./Desktop.tsx";
import type { SceneSchedule } from "./schedule.ts";

/** tcut's `dark-modern` background, so the clip blends into the window. */
const BACKGROUND = "#1f1f1f";

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
  // Stay one frame inside the clip so the last frame is always decodable.
  const last = capture.terminal ? Math.max(0, Math.floor(capture.terminal.duration * fps) - 1) : 0;
  const videoFrame = Math.min(Math.round(time * fps), last);
  return (
    <Window title={`${capture.project} — zsh`} background={BACKGROUND}>
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
