import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";
import type { Scene, Storyboard } from "./storyboard";
import { FPS, sceneDuration } from "./storyboard";
import { CodeScene } from "./scenes/Code";
import { EndScene } from "./scenes/End";
import { TerminalScene } from "./scenes/Terminal";
import { TitleScene } from "./scenes/Title";
import { t } from "./tokens";

const FADE = 10;

const Fade: React.FC<{
  durationInFrames: number;
  last: boolean;
  children: React.ReactNode;
}> = ({ durationInFrames, last, children }) => {
  const frame = useCurrentFrame();
  const opacity = last
    ? interpolate(frame, [0, FADE], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : interpolate(
        frame,
        [0, FADE, durationInFrames - FADE, durationInFrames],
        [0, 1, 1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const renderScene = (scene: Scene, durationInFrames: number) => {
  switch (scene.kind) {
    case "title":
      return (
        <TitleScene eyebrow={scene.eyebrow} title={scene.title} sub={scene.sub} />
      );
    case "code":
      return <CodeScene file={scene.file} lines={scene.lines} beats={scene.beats} />;
    case "terminal":
      return (
        <TerminalScene
          command={scene.command}
          header={scene.header}
          rows={scene.rows}
          output={scene.output}
          summary={scene.summary}
          subtitles={scene.subtitles}
          durationInFrames={durationInFrames}
        />
      );
    case "end":
      return <EndScene title={scene.title} url={scene.url} note={scene.note} />;
  }
};

export const Video: React.FC<{ storyboard: Storyboard }> = ({ storyboard }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: t.bg }}>
      {storyboard.scenes.map((scene, i) => {
        const durationInFrames = Math.round(sceneDuration(scene) * FPS);
        const el = (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <Fade
              durationInFrames={durationInFrames}
              last={i === storyboard.scenes.length - 1}
            >
              {renderScene(scene, durationInFrames)}
            </Fade>
          </Sequence>
        );
        from += durationInFrames;
        return el;
      })}
    </AbsoluteFill>
  );
};
