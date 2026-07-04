import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { t } from "../tokens";
import { Eyebrow, Ground, Yantra } from "./chrome";

export const TitleScene: React.FC<{
  eyebrow?: string;
  title: string;
  sub?: string;
}> = ({ eyebrow, title, sub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(frame, [0, 40], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleIn = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const subIn = spring({ frame: frame - 22, fps, config: { damping: 200 } });
  return (
    <Ground>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          textAlign: "center",
        }}
      >
        <Yantra size={110} draw={draw} />
        {eyebrow && (
          <div style={{ opacity: titleIn }}>
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
        )}
        <div
          style={{
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * 24}px)`,
            fontFamily: t.serif,
            fontSize: 96,
            fontWeight: 600,
            color: t.fg1,
            maxWidth: 1500,
            lineHeight: 1.12,
          }}
        >
          {title}
        </div>
        {sub && (
          <div
            style={{
              opacity: subIn,
              transform: `translateY(${(1 - subIn) * 18}px)`,
              fontSize: 40,
              color: t.fg2,
              maxWidth: 1200,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </div>
        )}
      </AbsoluteFill>
    </Ground>
  );
};
