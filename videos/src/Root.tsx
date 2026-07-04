import React from "react";
import { Composition } from "remotion";
import { infrastructureAsEffects } from "./storyboards/infrastructure-as-effects";
import { FPS, HEIGHT, totalFrames, WIDTH, type Storyboard } from "./storyboard";
import { Video } from "./Video";

const STORYBOARDS: Storyboard[] = [infrastructureAsEffects];

export const Root: React.FC = () => (
  <>
    {STORYBOARDS.map((sb) => (
      <Composition
        key={sb.id}
        id={sb.id}
        component={Video as React.FC<{ storyboard: Storyboard }>}
        durationInFrames={totalFrames(sb)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ storyboard: sb }}
      />
    ))}
  </>
);
