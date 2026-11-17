import { Composition } from "remotion";
import { VIDEO } from "./theme.ts";
import { DURATION, Video } from "./Video.tsx";

export const Root = () => (
  <Composition
    id="DomainVerify"
    component={Video}
    durationInFrames={DURATION}
    fps={VIDEO.fps}
    width={VIDEO.width}
    height={VIDEO.height}
  />
);
