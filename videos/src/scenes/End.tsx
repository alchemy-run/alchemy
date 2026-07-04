import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { t } from "../tokens";
import { Ground, Yantra } from "./chrome";

export const EndScene: React.FC<{
  title: string;
  url: string;
  note?: string;
}> = ({ title, url, note }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [0, 34], [0, 1], {
    extrapolateRight: "clamp",
  });
  const inA = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const inB = spring({ frame: frame - 18, fps, config: { damping: 200 } });
  return (
    <Ground>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 30,
          textAlign: "center",
        }}
      >
        <Yantra size={96} draw={draw} />
        <div
          style={{
            opacity: inA,
            fontFamily: t.serif,
            fontSize: 72,
            fontWeight: 600,
            color: t.fg1,
          }}
        >
          {title}
        </div>
        <div
          style={{
            opacity: inB,
            fontFamily: t.mono,
            fontSize: 42,
            color: t.accentBright,
          }}
        >
          {url}
        </div>
        {note && (
          <div style={{ opacity: inB, fontSize: 30, color: t.fg4 }}>{note}</div>
        )}
      </AbsoluteFill>
    </Ground>
  );
};
