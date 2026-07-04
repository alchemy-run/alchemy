import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CodeText } from "../highlight";
import type { CodeLine, ErrorCallout } from "../storyboard";
import { t } from "../tokens";
import { Ground, Panel, SubtitleBar } from "./chrome";

const CHARS_PER_SECOND = 55;

/**
 * Code panel scene. Two modes:
 * - type: true  — typewriter reveal across all lines, blinking cursor.
 * - type: false — base lines render immediately; lines marked "add" animate
 *   in staggered (diff mode), "del" lines fade to struck.
 */
export const CodeScene: React.FC<{
  file: string;
  lines: CodeLine[];
  type?: boolean;
  callouts?: ErrorCallout[];
  subtitles: string[];
  durationInFrames: number;
}> = ({ file, lines, type = true, callouts = [], subtitles, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fontSize = lines.length > 18 ? 26 : lines.length > 14 ? 30 : 33;
  const lineHeight = Math.round(fontSize * 1.62);

  // keep the panel clear of the subtitle bar: estimate its height and
  // scale down anything that would collide with the bottom zone.
  const estPanel =
    58 + 60 + lines.length * lineHeight + callouts.length * (fontSize * 2.6);
  const avail = 1080 - 210;
  const scale = Math.min(1, avail / estPanel);

  // typewriter bookkeeping
  const totalChars = lines.reduce((s, l) => s + l.text.length + 1, 0);
  const typed = Math.min(totalChars, (frame / fps) * CHARS_PER_SECOND);

  let consumed = 0;
  const addOrder: number[] = [];
  lines.forEach((l, i) => {
    if (l.mark === "add") addOrder.push(i);
  });

  return (
    <Ground>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: 130,
          transform: `scale(${scale})`,
        }}
      >
        <Panel file={file} width={1360}>
          <div style={{ padding: "30px 0", position: "relative" }}>
            {lines.map((line, i) => {
              // typewriter visibility
              const start = consumed;
              consumed += line.text.length + 1;
              let chars: number | undefined;
              let rowOpacity = 1;
              let translate = 0;
              if (type) {
                chars = Math.max(0, Math.floor(typed - start));
                if (chars === 0 && typed < start) chars = 0;
              } else if (line.mark === "add") {
                const order = addOrder.indexOf(i);
                const appear = fps * (0.9 + order * 0.55);
                rowOpacity = interpolate(frame, [appear, appear + 12], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                translate = interpolate(frame, [appear, appear + 12], [-14, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
              }
              const done = !type || (chars !== undefined && chars >= line.text.length);
              const showHighlight =
                line.highlight && done && frame > fps * 1.2;
              const bg =
                line.mark === "add"
                  ? "rgba(143, 177, 94, 0.13)"
                  : line.mark === "del"
                    ? "rgba(224, 108, 91, 0.12)"
                    : showHighlight
                      ? "rgba(179, 209, 136, 0.10)"
                      : "transparent";
              const callout = callouts.find((c) => c.line === i);
              return (
                <React.Fragment key={i}>
                  <div
                    style={{
                      display: "flex",
                      gap: 26,
                      padding: "0 34px",
                      minHeight: lineHeight,
                      lineHeight: `${lineHeight}px`,
                      background: bg,
                      opacity: rowOpacity,
                      transform: `translateX(${translate}px)`,
                      fontFamily: t.mono,
                      fontSize,
                      whiteSpace: "pre",
                      textDecoration:
                        line.mark === "del" ? "line-through" : undefined,
                    }}
                  >
                    <span
                      style={{
                        color:
                          line.mark === "add"
                            ? t.success
                            : line.mark === "del"
                              ? t.danger
                              : t.fg4,
                        width: 34,
                        textAlign: "right",
                        flexShrink: 0,
                        opacity: 0.8,
                      }}
                    >
                      {line.mark === "add" ? "+" : line.mark === "del" ? "-" : i + 1}
                    </span>
                    <span>
                      <CodeText line={line.text} chars={chars} />
                      {type &&
                        chars !== undefined &&
                        chars < line.text.length &&
                        typed >= start && (
                          <span
                            style={{
                              display: "inline-block",
                              width: fontSize * 0.55,
                              height: fontSize * 1.05,
                              background: t.accentBright,
                              verticalAlign: "text-bottom",
                              opacity: frame % 16 < 10 ? 1 : 0.15,
                            }}
                          />
                        )}
                    </span>
                  </div>
                  {callout && (
                    <Callout
                      callout={callout}
                      frame={frame}
                      fps={fps}
                      fontSize={fontSize}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </Panel>
      </AbsoluteFill>
      <SubtitleBar subtitles={subtitles} durationInFrames={durationInFrames} />
    </Ground>
  );
};

const Callout: React.FC<{
  callout: ErrorCallout;
  frame: number;
  fps: number;
  fontSize: number;
}> = ({ callout, frame, fps, fontSize }) => {
  const appear = fps * (callout.at ?? 1.6);
  const p = interpolate(frame, [appear, appear + 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (p === 0) return null;
  const isError = (callout.kind ?? "error") === "error";
  const color = isError ? t.danger : t.success;
  return (
    <div
      style={{
        margin: "8px 34px 12px 94px",
        opacity: p,
        transform: `translateY(${(1 - p) * -8}px)`,
        border: `1px solid ${color}`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 10,
        background: isError
          ? "rgba(224, 108, 91, 0.10)"
          : "rgba(143, 177, 94, 0.10)",
        padding: "14px 20px",
        fontFamily: t.mono,
        fontSize: fontSize * 0.82,
        color: t.fg1,
        whiteSpace: "pre-wrap",
      }}
    >
      {isError ? "✗ " : "✓ "}
      {callout.text}
    </div>
  );
};
