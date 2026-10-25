import { AbsoluteFill, useCurrentFrame } from "remotion";
import { enter, progress } from "./anim.ts";
import type { Scene } from "./scene.ts";
import { Code } from "./scenes/Code.tsx";
import { Pyramid } from "./scenes/Pyramid.tsx";
import { Section, Title } from "./scenes/Slides.tsx";
import { Terminal } from "./scenes/Terminal.tsx";
import { ranges, steps } from "./steps.ts";
import { color, font } from "./theme.ts";

/** The whole talk as one composition: each step plays in its own range of frames, then holds. */
export const Talk = () => {
  const frame = useCurrentFrame();
  const i = Math.max(
    0,
    ranges.findLastIndex((r) => frame >= r.from),
  );
  const t = frame - ranges[i]!.from;
  const step = steps[i]!;
  const prev = steps[i - 1];
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 10% 0%, #2a2a1a 0%, transparent 60%), radial-gradient(900px 600px at 95% 100%, #2a1c14 0%, transparent 60%), ${color.bg}`,
      }}
    >
      {step.title && (
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 52,
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: 50,
            color: color.fg,
            ...(prev?.title === step.title ? {} : enter(progress(t, 0, 10))),
          }}
        >
          {step.title}
        </div>
      )}
      <SceneView scene={step.scene} prev={prev?.scene} t={t} />
    </AbsoluteFill>
  );
};

const SceneView = ({ scene, prev, t }: { scene: Scene; prev?: Scene; t: number }) => {
  switch (scene.kind) {
    case "title":
      return <Title {...scene} t={t} />;
    case "section":
      return <Section heading={scene.heading} t={t} />;
    case "code":
      return <Code scene={scene} prev={prev} t={t} />;
    case "pyramid":
      return <Pyramid scene={scene} prev={prev} t={t} />;
    case "terminal":
      return <Terminal {...scene} t={t} />;
  }
};
