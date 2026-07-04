import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CodeText } from "../highlight";
import type { Beat, CodeLine } from "../storyboard";
import { t } from "../tokens";
import { Ground, Panel, SubtitleBar } from "./chrome";

/**
 * Beat-driven code panel. The whole file renders instantly; narration beats
 * then steer attention: focused lines get an accent wash while the rest dim,
 * "+" lines splice in green, "-" lines get struck red, callouts pop under
 * their line — all cut in rhythm with the subtitle changes.
 */
export const CodeScene: React.FC<{
  file: string;
  lines: CodeLine[];
  beats: Beat[];
}> = ({ file, lines, beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // beat boundaries in frames
  const starts: number[] = [];
  let acc = 0;
  for (const b of beats) {
    starts.push(acc);
    acc += Math.round(b.duration * fps);
  }
  let beatIdx = 0;
  for (let i = 0; i < beats.length; i++) {
    if (frame >= starts[i]) beatIdx = i;
  }
  const beat = beats[beatIdx];
  const beatFrame = frame - starts[beatIdx];

  // does the current beat spotlight anything? (drives global dimming)
  const hasFocus = lines.some((l) => l.focusAt?.includes(beatIdx));

  // size by line count, then shrink until the longest line fits the panel
  // (JetBrains Mono glyphs are ~0.6em wide; text area = 1360 minus gutter/padding)
  const sizeByLines = lines.length > 18 ? 26 : lines.length > 14 ? 30 : 33;
  const maxChars = Math.max(...lines.map((l) => l.text.length), 1);
  const sizeByWidth = Math.floor(1216 / (0.6 * maxChars));
  const fontSize = Math.min(sizeByLines, sizeByWidth);
  const lineHeight = Math.round(fontSize * 1.62);

  // visible-at-current-beat line count for the scale estimate
  const visibleCount = lines.filter(
    (l) => l.appearAt === undefined || l.appearAt <= beatIdx,
  ).length;
  const estPanel =
    58 + 60 + Math.max(visibleCount, lines.length) * lineHeight + (beat.callout ? fontSize * 2.6 : 0);
  const avail = 1080 - 210;
  const scale = Math.min(1, avail / estPanel);

  // gutter numbering skips diff rows so the file reads like a real editor
  let gutterNo = 0;

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
              const isAdd = line.appearAt !== undefined;
              const appeared = isAdd ? beatIdx >= line.appearAt! : true;
              const deleted = line.delAt !== undefined && beatIdx >= line.delAt;
              const focused = line.focusAt?.includes(beatIdx) ?? false;
              if (!isAdd && !deleted) gutterNo += 1;
              const lineNo = gutterNo;

              if (isAdd && !appeared) return null;

              // splice-in animation on the add line's own beat
              const appearP =
                isAdd && beatIdx === line.appearAt
                  ? interpolate(beatFrame, [0, 8], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    })
                  : 1;
              // strike animation on the del line's own beat
              const delP = deleted
                ? line.delAt === beatIdx
                  ? interpolate(beatFrame, [0, 8], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    })
                  : 1
                : 0;
              // focus wash ramps in at the start of each beat
              const focusP = focused
                ? interpolate(beatFrame, [0, 6], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  })
                : 0;

              // everything not spotlit (and not an active diff row) recedes
              const active =
                focused ||
                (isAdd && beatIdx === line.appearAt) ||
                (deleted && line.delAt === beatIdx);
              const dim =
                hasFocus && !active
                  ? interpolate(beatFrame, [0, 6], [1, 0.34], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    })
                  : 1;

              const bg = isAdd
                ? `rgba(143, 177, 94, ${0.16 * appearP})`
                : delP > 0
                  ? `rgba(224, 108, 91, ${0.14 * delP})`
                  : focusP > 0
                    ? `rgba(179, 209, 136, ${0.12 * focusP})`
                    : "transparent";

              return (
                <React.Fragment key={i}>
                  <div
                    style={{
                      display: "flex",
                      gap: 26,
                      padding: "0 34px",
                      height: isAdd ? lineHeight * appearP : lineHeight,
                      overflow: "hidden",
                      lineHeight: `${lineHeight}px`,
                      background: bg,
                      opacity: isAdd ? appearP : dim,
                      borderLeft:
                        focusP > 0
                          ? `4px solid rgba(179, 209, 136, ${focusP})`
                          : "4px solid transparent",
                      fontFamily: t.mono,
                      fontSize,
                      whiteSpace: "pre",
                      textDecoration: delP > 0.5 ? "line-through" : undefined,
                    }}
                  >
                    <span
                      style={{
                        color: isAdd ? t.success : delP > 0 ? t.danger : t.fg4,
                        width: 34,
                        textAlign: "right",
                        flexShrink: 0,
                        opacity: 0.8,
                      }}
                    >
                      {isAdd ? "+" : delP > 0 ? "-" : lineNo}
                    </span>
                    <span>
                      <CodeText line={line.text} />
                    </span>
                  </div>
                  {beat.callout && beat.callout.line === i && (
                    <Callout
                      text={beat.callout.text}
                      kind={beat.callout.kind ?? "error"}
                      beatFrame={beatFrame}
                      fontSize={fontSize}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </Panel>
      </AbsoluteFill>
      <SubtitleBar
        segments={beats.map((b, i) => ({
          text: b.subtitle,
          from: starts[i],
          durationInFrames: Math.round(b.duration * fps),
        }))}
      />
    </Ground>
  );
};

const Callout: React.FC<{
  text: string;
  kind: "error" | "ok";
  beatFrame: number;
  fontSize: number;
}> = ({ text, kind, beatFrame, fontSize }) => {
  const p = interpolate(beatFrame, [4, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (p === 0) return null;
  const isError = kind === "error";
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
      {text}
    </div>
  );
};
