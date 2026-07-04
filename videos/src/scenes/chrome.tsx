import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FPS } from "../storyboard";
import { t, YANTRA } from "../tokens";

/** Page ground: warm near-black with the site's faint accent wash on top. */
export const Ground: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <AbsoluteFill
    style={{
      background: `linear-gradient(to bottom, rgba(122,154,94,0.07), transparent 42%), ${t.bg}`,
      fontFamily: t.sans,
    }}
  >
    {children}
  </AbsoluteFill>
);

/** The brand mark — circle, inscribed water triangle, centroid dot. */
export const Yantra: React.FC<{ size: number; draw?: number }> = ({
  size,
  draw = 1,
}) => {
  const circumference = 2 * Math.PI * YANTRA.circle.r;
  const triPerimeter = 3 * 16.545; // side length of the inscribed triangle
  return (
    <svg
      width={size}
      height={size}
      viewBox={YANTRA.viewBox}
      fill="none"
      style={{ display: "block" }}
    >
      <circle
        cx={YANTRA.circle.cx}
        cy={YANTRA.circle.cy}
        r={YANTRA.circle.r}
        stroke={t.accentBright}
        strokeWidth={1.1}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, draw * 1.4))}
      />
      <path
        d={YANTRA.trianglePath}
        stroke={t.accentBright}
        strokeWidth={1.1}
        strokeLinejoin="round"
        strokeDasharray={triPerimeter}
        strokeDashoffset={triPerimeter * (1 - Math.max(0, Math.min(1, draw * 1.6 - 0.4)))}
      />
      <circle
        cx={YANTRA.dot.cx}
        cy={YANTRA.dot.cy}
        r={YANTRA.dot.r}
        fill={t.accentBright}
        opacity={Math.max(0, Math.min(1, draw * 3 - 2))}
      />
    </svg>
  );
};

/** Small-caps mono eyebrow, the site's signature label. */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      fontFamily: t.mono,
      fontSize: 26,
      letterSpacing: "0.28em",
      textTransform: "uppercase",
      color: t.accentBright,
    }}
  >
    {children}
  </div>
);

/** Rounded panel with macOS dots and a filename chip. */
export const Panel: React.FC<{
  file?: string;
  width: number;
  children: React.ReactNode;
}> = ({ file, width, children }) => (
  <div
    style={{
      width,
      flexShrink: 0,
      background: t.bgElev1,
      border: `1px solid ${t.hairline2}`,
      borderRadius: 18,
      overflow: "hidden",
      boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "16px 22px",
        borderBottom: `1px solid ${t.hairline}`,
      }}
    >
      {["#e0655a", "#e0b34e", "#7fb069"].map((c) => (
        <div
          key={c}
          style={{ width: 14, height: 14, borderRadius: 7, background: c, opacity: 0.85 }}
        />
      ))}
      {file && (
        <div
          style={{
            marginLeft: 14,
            fontFamily: t.mono,
            fontSize: 22,
            color: t.fg4,
          }}
        >
          {file}
        </div>
      )}
    </div>
    {children}
  </div>
);

export interface SubtitleSegment {
  text: string;
  from: number;
  durationInFrames: number;
}

/**
 * Bottom captions. Pass explicit `segments` (beat-timed), or
 * `subtitles` + `durationInFrames` to spread lines evenly across the scene.
 */
export const SubtitleBar: React.FC<{
  subtitles?: string[];
  durationInFrames?: number;
  segments?: SubtitleSegment[];
}> = ({ subtitles, durationInFrames, segments }) => {
  const frame = useCurrentFrame();
  const segs: SubtitleSegment[] =
    segments ??
    (subtitles ?? []).map((text, i, arr) => {
      const per = (durationInFrames ?? 0) / arr.length;
      return { text, from: i * per, durationInFrames: per };
    });
  if (segs.length === 0) return null;
  let idx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (frame >= segs[i].from) idx = i;
  }
  const seg = segs[idx];
  const local = frame - seg.from;
  const per = seg.durationInFrames;
  const opacity = interpolate(
    local,
    [0, 10, per - 8, per],
    [0, 1, 1, idx === segs.length - 1 ? 1 : 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const rise = interpolate(local, [0, 10], [10, 0], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 64,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateY(${rise}px)`,
          maxWidth: 1400,
          background: "rgba(20, 17, 13, 0.82)",
          border: `1px solid ${t.hairline2}`,
          borderRadius: 14,
          padding: "18px 34px",
          fontSize: 36,
          fontFamily: t.sans,
          fontWeight: 500,
          color: t.fg1,
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {seg.text}
      </div>
    </div>
  );
};

/** Frames helper. */
export const sec = (s: number) => Math.round(s * FPS);
