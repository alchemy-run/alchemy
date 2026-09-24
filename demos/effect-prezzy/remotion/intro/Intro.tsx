import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  watchStaticFile,
  type CalculateMetadataFunction,
} from "remotion";
import { introTimeline, type CodeStep, type IntroJson, type IntroStep } from "../../shared/intro.ts";
import { VIDEO } from "../../shared/types.ts";
import { sans } from "../fonts.ts";
import { Slide } from "../slides/Slide.tsx";
import { brand } from "../theme.ts";
import { Board } from "./boards.tsx";
import { CodeSlide } from "./CodeSlide.tsx";

export interface IntroProps extends Record<string, unknown> {
  intro?: IntroJson;
}

export const calculateIntroMetadata: CalculateMetadataFunction<IntroProps> = async ({ props }) => {
  const response = await fetch(staticFile("intro/intro.json"));
  if (!response.ok) throw new Error("No intro build. Run `pnpm intro:build` first.");
  const intro = (await response.json()) as IntroJson;
  const total = intro.steps.reduce((sum, step) => sum + step.frames, 0);
  return { durationInFrames: Math.max(1, total), fps: VIDEO.fps, props: { ...props, intro } };
};

/** Same dark stage as the slides, without their headline layout. */
const Stage = () => (
  <AbsoluteFill
    style={{
      background: [
        `radial-gradient(900px 700px at 12% 18%, ${brand.moss}1c, transparent 65%)`,
        `radial-gradient(900px 700px at 88% 90%, ${brand.ember}18, transparent 65%)`,
        brand.bg,
      ].join(","),
    }}
  />
);

export const Intro = ({ intro }: IntroProps) => {
  const frame = useCurrentFrame();
  if (!intro) return null;
  const ranges = introTimeline(intro.steps);
  const index = Math.max(0, ranges.findIndex((r) => frame >= r.from && frame < r.to));
  const at = index < 0 ? intro.steps.length - 1 : index;
  const step = intro.steps[at]!;
  const local = frame - ranges[at]!.from;
  const prev: IntroStep | undefined = intro.steps[at - 1];

  if (step.kind === "slide") {
    return <Slide layout={step.layout} props={{ eyebrow: step.eyebrow, heading: step.heading, subtitle: step.subtitle }} />;
  }
  // The caption stays put across steps that share it.
  // The step's title is the slide's heading; it changes with every step.
  const titleIn = prev && prev.title === step.title ? 1 : Math.min(1, local / 5);
  return (
    <AbsoluteFill>
      <Stage />
      {step.kind === "code" ? (
        <CodeSlide
          step={step}
          prev={prev?.kind === "code" ? prev : undefined}
          prev2={intro.steps[at - 2]?.kind === "code" ? (intro.steps[at - 2] as CodeStep) : undefined}
          local={local}
        />
      ) : (
        <Board board={step.board} stage={step.stage} local={local} />
      )}
      <div
        style={{
          position: "absolute",
          left: 110,
          right: 110,
          top: 44,
          fontFamily: sans,
          fontSize: 52,
          fontWeight: 700,
          letterSpacing: -0.6,
          lineHeight: 1.15,
          color: brand.fg,
          opacity: titleIn,
          transform: `translateY(${(1 - titleIn) * 6}px)`,
        }}
      >
        {step.title}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Studio-only live preview: loads intro.json itself and reloads it whenever
 * `pnpm dev` rebuilds it, so edits to intro/steps.ts or a snippet show up
 * without restarting anything. Scrub or press → in the Studio timeline.
 */
export const IntroLive = () => {
  const [intro, setIntro] = useState<IntroJson>();
  const [handle] = useState(() => delayRender("loading intro.json"));
  useEffect(() => {
    const load = () =>
      fetch(`${staticFile("intro/intro.json")}?t=${Date.now()}`)
        .then((r) => r.json())
        .then((json: IntroJson) => {
          setIntro(json);
          continueRender(handle);
        });
    load();
    const watcher = watchStaticFile("intro/intro.json", () => load());
    return () => watcher.cancel();
  }, [handle]);
  return <Intro intro={intro} />;
};
