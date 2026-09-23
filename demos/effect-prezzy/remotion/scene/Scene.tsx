import type { ReactNode } from "react";
import {
  AbsoluteFill,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { VIDEO, type AppId, type SceneCapture } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { AppSwitcher, MenuBar, Wallpaper } from "./Desktop.tsx";
import { Browser } from "./Browser.tsx";
import { Diagram } from "./Diagram.tsx";
import { Editor } from "./Editor.tsx";
import { schedule, segmentAt, TIMING, type SceneSchedule } from "./schedule.ts";
import { Terminal } from "./Terminal.tsx";

export interface SceneProps extends Record<string, unknown> {
  id: string;
  capture?: SceneCapture;
  plan?: SceneSchedule;
}

/** Loads `out/capture/<id>/scene.json` and lays its beats out on frames. */
export const calculateSceneMetadata: CalculateMetadataFunction<SceneProps> = async ({
  props,
}) => {
  const response = await fetch(staticFile(`${props.id}/scene.json`));
  if (!response.ok) {
    throw new Error(`No capture for scene "${props.id}". Run \`pnpm capture\` first.`);
  }
  const capture = (await response.json()) as SceneCapture;
  const { fps } = VIDEO;
  const plan = await schedule(capture, fps);
  return { durationInFrames: plan.durationInFrames, fps, props: { ...props, capture, plan } };
};

/** The caption in effect at `frame`, and how many frames it has been up. */
const captionAt = (plan: SceneSchedule, frame: number) => {
  let caption: { text: string; since: number } | undefined;
  for (const segment of plan.segments) {
    if (segment.from > frame) break;
    const { beat } = segment;
    // Every step's title is its caption; an explicit caption beat overrides it.
    if (beat.kind === "step" || beat.kind === "caption") {
      const text = beat.kind === "step" ? beat.title : beat.text;
      if (caption?.text !== text) caption = { text, since: frame - segment.from };
    }
  }
  return caption;
};

const Caption = ({ text, since }: { text: string; since: number }) => {
  const t = interpolate(since, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 72,
        display: "flex",
        justifyContent: "center",
        opacity: t,
        transform: `translateY(${(1 - t) * 12}px)`,
      }}
    >
      <div
        style={{
          maxWidth: 1500,
          textAlign: "center",
          fontFamily: sans,
          fontSize: 38,
          fontWeight: 600,
          lineHeight: 1.25,
          color: "#ffffff",
          letterSpacing: -0.2,
          // Subtitle style: plain text, legible over any window.
          textShadow:
            "0 0 2px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9), 0 0 18px rgba(0,0,0,0.75)",
          WebkitTextStroke: "0.5px rgba(0,0,0,0.6)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

export const Scene = ({ capture, plan }: SceneProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!capture || !plan) return null;

  const segment = segmentAt(plan.segments, frame);
  const focused: AppId = segment?.app ?? "editor";
  const local = segment ? frame - segment.from : 0;
  const switching = segment !== undefined && segment.switchFrames > 0 && local < segment.switchFrames;
  // The target window comes forward once the switcher has picked it.
  const raise = switching
    ? interpolate(local, [TIMING.switchOverlay, TIMING.switchOverlay + TIMING.raise], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const front: AppId = switching && raise === 0 ? segment.previous : focused;
  const behind: AppId | undefined = switching && raise > 0 ? segment.previous : undefined;

  const windows: Record<AppId, ReactNode> = {
    editor: <Editor capture={capture} plan={plan} frame={frame} />,
    terminal: <Terminal capture={capture} plan={plan} frame={frame} fps={fps} />,
    diagram: <Diagram capture={capture} plan={plan} frame={frame} />,
    browser: <Browser capture={capture} plan={plan} frame={frame} />,
  };

  return (
    <AbsoluteFill>
      <Wallpaper />
      <MenuBar app={switching && raise < 0.5 ? segment.previous : focused} />
      {behind ? <AbsoluteFill>{windows[behind]}</AbsoluteFill> : null}
      <AbsoluteFill
        style={
          behind
            ? { opacity: raise, transform: `scale(${0.985 + 0.015 * raise})` }
            : undefined
        }
      >
        {windows[front]}
      </AbsoluteFill>
      {switching ? (
        <AppSwitcher
          frame={local}
          duration={TIMING.switchOverlay}
          from={segment.previous}
          to={segment.app}
        />
      ) : null}
      {(() => {
        const caption = captionAt(plan, frame);
        return caption ? <Caption key={caption.text} {...caption} /> : null;
      })()}
    </AbsoluteFill>
  );
};
