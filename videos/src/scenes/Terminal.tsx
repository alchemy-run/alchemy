import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TerminalRow } from "../storyboard";
import { t } from "../tokens";
import { Ground, Panel, SubtitleBar } from "./chrome";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

/**
 * Terminal scene modeled on the landing page's DeployTerminal: a typed
 * command, resource rows that spin then check, and an accent summary line.
 */
export const TerminalScene: React.FC<{
  command: string;
  header?: string;
  rows?: TerminalRow[];
  output?: string[];
  summary?: string;
  subtitles: string[];
  durationInFrames: number;
}> = ({
  command,
  header,
  rows = [],
  output = [],
  summary,
  subtitles,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cmdChars = Math.min(command.length, Math.floor((frame / fps) * 28));
  const cmdDone = cmdChars >= command.length;
  const afterCmd = frame - (command.length / 28) * fps - fps * 0.4;

  const rowAppear = (i: number) => fps * 0.2 + i * fps * 0.35;
  const rowDone = (i: number) => rowAppear(i) + fps * (1.1 + i * 0.25);
  const allDone =
    rows.length === 0 ? 0 : rowDone(rows.length - 1) + fps * 0.35;

  const fontSize = 30;
  const lineHeight = 52;

  return (
    <Ground>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Panel width={1240}>
          <div
            style={{
              padding: "34px 42px",
              fontFamily: t.mono,
              fontSize,
              minHeight: 120 + (rows.length + output.length) * lineHeight,
            }}
          >
            <div style={{ color: t.fg1, lineHeight: `${lineHeight}px` }}>
              <span style={{ color: t.accentBright }}>❯ </span>
              {command.slice(0, cmdChars)}
              {!cmdDone && (
                <span
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 32,
                    background: t.accentBright,
                    verticalAlign: "text-bottom",
                    opacity: frame % 16 < 10 ? 1 : 0.15,
                  }}
                />
              )}
            </div>
            {cmdDone && header && afterCmd > 0 && (
              <div
                style={{
                  color: t.fg4,
                  lineHeight: `${lineHeight}px`,
                  opacity: interpolate(afterCmd, [0, 8], [0, 1], {
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                {header}
              </div>
            )}
            {cmdDone &&
              rows.map((row, i) => {
                const local = afterCmd - rowAppear(i);
                if (local < 0) return null;
                const done = afterCmd > rowDone(i);
                const del = row.verb === "delete";
                return (
                  <div
                    key={row.id}
                    style={{
                      display: "flex",
                      gap: 20,
                      lineHeight: `${lineHeight}px`,
                      opacity: interpolate(local, [0, 6], [0, 1], {
                        extrapolateRight: "clamp",
                      }),
                    }}
                  >
                    <span
                      style={{
                        color: done ? (del ? t.danger : t.success) : t.fg4,
                        width: 30,
                      }}
                    >
                      {done
                        ? del
                          ? "−"
                          : "✓"
                        : SPINNER[Math.floor(frame / 3) % SPINNER.length]}
                    </span>
                    <span style={{ color: t.fg1, minWidth: 240 }}>{row.id}</span>
                    <span style={{ color: t.fg4 }}>{row.type}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        color: done ? (del ? t.danger : t.success) : t.fg4,
                      }}
                    >
                      {done ? (del ? "deleted" : "created") : del ? "deleting…" : "creating…"}
                    </span>
                  </div>
                );
              })}
            {cmdDone &&
              output.map((line, i) => {
                const local = afterCmd - fps * 0.5 - i * fps * 0.3;
                if (local < 0) return null;
                return (
                  <div
                    key={i}
                    style={{
                      color: t.fg2,
                      lineHeight: `${lineHeight}px`,
                      opacity: interpolate(local, [0, 6], [0, 1], {
                        extrapolateRight: "clamp",
                      }),
                    }}
                  >
                    {line}
                  </div>
                );
              })}
            {cmdDone && summary && afterCmd > allDone && (
              <div
                style={{
                  marginTop: 18,
                  lineHeight: `${lineHeight}px`,
                  color: t.accentBright,
                  fontWeight: 600,
                  opacity: interpolate(afterCmd - allDone, [0, 10], [0, 1], {
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                {summary}
              </div>
            )}
          </div>
        </Panel>
      </AbsoluteFill>
      <SubtitleBar subtitles={subtitles} durationInFrames={durationInFrames} />
    </Ground>
  );
};
