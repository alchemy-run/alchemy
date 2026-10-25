import { AbsoluteFill, useCurrentFrame } from "remotion";
import { enter, progress } from "./anim.ts";
import type { Scene } from "./scene.ts";
import { Deploy } from "./scenes/Deploy.tsx";
import { Dev } from "./scenes/Dev.tsx";
import { Engine } from "./scenes/Engine.tsx";
import { Glance } from "./scenes/Glance.tsx";
import { Hero } from "./scenes/Hero.tsx";
import { Layers } from "./scenes/Layers.tsx";
import { Loop } from "./scenes/Loop.tsx";
import { OneLine } from "./scenes/OneLine.tsx";
import { Permissions } from "./scenes/Permissions.tsx";
import { Phases } from "./scenes/Phases.tsx";
import { Versus } from "./scenes/Versus.tsx";
import { ranges, steps } from "./steps.ts";
import { color } from "./theme.ts";
import { Heading } from "./ui.tsx";

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
  const sameHeading = prev?.heading === step.heading && prev?.lede === step.lede;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1100px 700px at 8% 0%, #232614 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #2a1c14 0%, transparent 60%), ${color.bg}`,
      }}
    >
      {step.heading && (
        <div style={sameHeading ? undefined : enter(progress(t, 0, 10))}>
          <Heading heading={step.heading} lede={step.lede} />
        </div>
      )}
      <SceneView scene={step.scene} prev={prev?.scene} t={t} />
    </AbsoluteFill>
  );
};

const SceneView = ({ scene, prev, t }: { scene: Scene; prev?: Scene; t: number }) => {
  switch (scene.kind) {
    case "hero":
      return <Hero {...scene} t={t} />;
    case "versus":
      return <Versus scene={scene} prev={prev} t={t} />;
    case "oneLine":
      return <OneLine scene={scene} prev={prev} t={t} />;
    case "permissions":
      return <Permissions t={t} />;
    case "phases":
      return <Phases scene={scene} prev={prev} t={t} />;
    case "layers":
      return <Layers scene={scene} prev={prev} t={t} />;
    case "engine":
      return <Engine t={t} />;
    case "deploy":
      return <Deploy t={t} />;
    case "dev":
      return <Dev scene={scene} prev={prev} t={t} />;
    case "loop":
      return <Loop t={t} />;
    case "glance":
      return <Glance t={t} />;
  }
};
