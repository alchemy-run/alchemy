import { Composition } from "remotion";
import { totalFrames } from "./steps.ts";
import { Talk } from "./Talk.tsx";
import { VIDEO } from "./theme.ts";

export const Root = () => (
  <Composition
    id="WhatIsAlchemy"
    component={Talk}
    durationInFrames={totalFrames}
    fps={VIDEO.fps}
    width={VIDEO.width}
    height={VIDEO.height}
  />
);
