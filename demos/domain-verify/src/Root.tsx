import { Composition } from "remotion";
import { VIDEO } from "./theme.ts";
import { DURATION, Video } from "./Video.tsx";

const size = {
  durationInFrames: DURATION,
  fps: VIDEO.fps,
  width: VIDEO.width,
  height: VIDEO.height,
} as const;

export const Root = () => (
  <>
    <Composition id="DomainVerify" component={Video} defaultProps={{ guide: false }} {...size} />
    {/* The same video with the corner kept for a camera picture outlined. */}
    <Composition
      id="DomainVerifyGuide"
      component={Video}
      defaultProps={{ guide: true }}
      {...size}
    />
  </>
);
