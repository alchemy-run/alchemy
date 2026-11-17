import type { ComponentType } from "react";
import { AbsoluteFill, Series } from "remotion";
import { Decisions } from "./scenes/Decisions.tsx";
import { Explore } from "./scenes/Explore.tsx";
import { Model } from "./scenes/Model.tsx";
import { OneTest } from "./scenes/OneTest.tsx";
import { Outro } from "./scenes/Outro.tsx";
import { Prove } from "./scenes/Prove.tsx";
import { Report } from "./scenes/Report.tsx";
import { Rules } from "./scenes/Rules.tsx";
import { Sample } from "./scenes/Sample.tsx";
import { Title } from "./scenes/Title.tsx";
import { brand, s } from "./theme.ts";

/** The scenes in order, each with its length in seconds. */
export const SCENES: ReadonlyArray<{
  readonly name: string;
  readonly seconds: number;
  readonly component: ComponentType<{ length: number }>;
}> = [
  { name: "title", seconds: 5, component: Title },
  { name: "model", seconds: 12, component: Model },
  { name: "rules", seconds: 13, component: Rules },
  { name: "one-test", seconds: 9, component: OneTest },
  { name: "prove", seconds: 15, component: Prove },
  { name: "decisions", seconds: 13, component: Decisions },
  { name: "explore", seconds: 16, component: Explore },
  { name: "sample", seconds: 14, component: Sample },
  { name: "report", seconds: 11, component: Report },
  { name: "outro", seconds: 6, component: Outro },
];

export const DURATION = SCENES.reduce((total, scene) => total + s(scene.seconds), 0);

export const Video = () => (
  <AbsoluteFill style={{ background: brand.bg }}>
    <Series>
      {SCENES.map((scene) => (
        <Series.Sequence key={scene.name} durationInFrames={s(scene.seconds)}>
          <scene.component length={s(scene.seconds)} />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
