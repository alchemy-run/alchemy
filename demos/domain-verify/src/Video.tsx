import type { ComponentType } from "react";
import { AbsoluteFill, Series } from "remotion";
import { Broken } from "./scenes/Broken.tsx";
import { Decision } from "./scenes/Decision.tsx";
import { Hook } from "./scenes/Hook.tsx";
import { Proof } from "./scenes/Proof.tsx";
import { Report } from "./scenes/Report.tsx";
import { Sequence } from "./scenes/Sequence.tsx";
import { Write } from "./scenes/Write.tsx";
import { brand, s } from "./theme.ts";

/** The scenes in order, each with its length in seconds. */
export const SCENES: ReadonlyArray<{
  readonly name: string;
  readonly seconds: number;
  readonly component: ComponentType<{ length: number }>;
}> = [
  { name: "hook", seconds: 3, component: Hook },
  { name: "write", seconds: 8.5, component: Write },
  { name: "proof", seconds: 9, component: Proof },
  { name: "broken", seconds: 8, component: Broken },
  { name: "decision", seconds: 8, component: Decision },
  { name: "sequence", seconds: 8, component: Sequence },
  { name: "report", seconds: 5.5, component: Report },
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
