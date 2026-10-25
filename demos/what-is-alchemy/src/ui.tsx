import type { CSSProperties, ReactNode } from "react";
import { highlightTs, highlightYaml } from "./highlight.ts";
import { locate } from "./snippet.ts";
import { color, font } from "./theme.ts";

/** A code window like the website's code blocks: three dots, a file name, the code. */
export const PAD = { x: 28, header: 52, y: 20 } as const;

export const metrics = (fs: number) => ({ lh: fs * 1.6, cw: fs * 0.6 });

export const windowHeight = (code: string, fs: number) =>
  PAD.header + PAD.y * 2 + code.split("\n").length * metrics(fs).lh;

/** Where `find` sits in a window, in composition pixels. */
export const span = (win: { x: number; y: number; fs: number; code: string }, find: string) => {
  const { lh, cw } = metrics(win.fs);
  const at = locate(win.code, find);
  const x1 = win.x + PAD.x + at.col * cw;
  const top = win.y + PAD.header + PAD.y + at.line * lh;
  return { x1, x2: x1 + at.len * cw, top, bottom: top + lh, mid: top + lh / 2, line: at.line };
};

export interface Lit {
  find: string;
  color: string;
  /** 0 → 1: how strongly it's lit. */
  p: number;
}

export const Window = (props: {
  x: number;
  y: number;
  w: number;
  fs: number;
  file: string;
  code: string;
  lang?: "ts" | "yaml";
  /** Lines lit as a whole row, by text they contain. */
  lit?: Lit[];
  /** 0 → 1: fades the lines that aren't lit. */
  dim?: number;
  /** The code this window showed before: changed lines roll from it, `roll` 0 → 1. */
  from?: string;
  roll?: number;
  style?: CSSProperties;
}) => {
  const { lh } = metrics(props.fs);
  const lines = props.code.split("\n");
  const before = props.from?.split("\n");
  const roll = props.roll ?? 1;
  const litRows = new Map<number, Lit>();
  for (const l of props.lit ?? []) litRows.set(locate(props.code, l.find).line, l);
  const row = (text: string) =>
    (props.lang === "yaml" ? highlightYaml(text) : highlightTs(text)).map((tok, k) => (
      <span key={k} style={{ color: tok.color }}>
        {tok.text}
      </span>
    ));
  return (
    <div
      style={{
        position: "absolute",
        left: props.x,
        top: props.y,
        width: props.w,
        height: windowHeight(props.code, props.fs),
        background: "#1a1713",
        border: `1px solid ${color.hairline}`,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 30px 60px rgba(0,0,0,0.35)",
        ...props.style,
      }}
    >
      <div
        style={{
          height: PAD.header,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 20px",
          borderBottom: `1px solid ${color.hairline}`,
          background: "#201c17",
        }}
      >
        {[color.red, "#e0b04f", color.moss].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <span style={{ marginLeft: 12, fontFamily: font.mono, fontSize: 18, color: color.muted }}>
          {props.file}
        </span>
      </div>
      {lines.map((text, n) => {
        const lit = litRows.get(n);
        const changed = before !== undefined && before[n] !== text;
        return (
          <div
            key={n}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: PAD.header + PAD.y + n * lh,
              height: lh,
              overflow: "hidden",
              background: lit
                ? `color-mix(in srgb, ${lit.color} ${Math.round(lit.p * 16)}%, transparent)`
                : changed
                  ? `color-mix(in srgb, ${color.moss} ${Math.round(roll * 12)}%, transparent)`
                  : undefined,
              boxShadow: lit ? `inset ${Math.round(lit.p * 4)}px 0 0 ${lit.color}` : undefined,
              opacity: lit ? 1 : 1 - (props.dim ?? 0) * 0.6,
            }}
          >
            {[
              changed ? { text: before![n] ?? "", y: -roll * lh } : null,
              { text, y: changed ? (1 - roll) * lh : 0 },
            ].map(
              (l, k) =>
                l && (
                  <div
                    key={k}
                    style={{
                      position: "absolute",
                      left: PAD.x,
                      top: l.y,
                      lineHeight: `${lh}px`,
                      fontFamily: font.mono,
                      fontSize: props.fs,
                      whiteSpace: "pre",
                    }}
                  >
                    {row(l.text)}
                  </div>
                ),
            )}
          </div>
        );
      })}
    </div>
  );
};

/** The scene's heading, set like the website's section headings. */
export const Heading = (p: { heading: string; lede?: string; style?: CSSProperties }) => (
  <div style={{ position: "absolute", left: 120, top: 70, width: 1680, ...p.style }}>
    <div
      style={{
        fontFamily: font.serif,
        fontWeight: 600,
        fontSize: 64,
        lineHeight: 1.1,
        color: color.fg,
      }}
    >
      {p.heading}
    </div>
    {p.lede && (
      <div
        style={{
          fontFamily: font.sans,
          fontSize: 28,
          lineHeight: 1.45,
          color: color.muted,
          marginTop: 14,
          maxWidth: 1400,
        }}
      >
        {p.lede}
      </div>
    )}
  </div>
);

/** A small rounded label. */
export const Pill = (p: { children: ReactNode; color: string; style?: CSSProperties }) => (
  <div
    style={{
      position: "absolute",
      padding: "8px 18px",
      borderRadius: 999,
      border: `2px solid ${p.color}`,
      background: `color-mix(in srgb, ${p.color} 14%, ${color.bg})`,
      color: p.color,
      fontFamily: font.sans,
      fontWeight: 600,
      fontSize: 24,
      whiteSpace: "nowrap",
      ...p.style,
    }}
  >
    {p.children}
  </div>
);

/** A full-frame SVG layer for lines and connectors. */
export const Svg = (p: { children: ReactNode; style?: CSSProperties }) => (
  <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, ...p.style }}>
    {p.children}
  </svg>
);

/** Props that draw an SVG path in as `p` goes 0 → 1. */
export const drawn = (p: number) => ({
  pathLength: 1,
  strokeDasharray: 1,
  strokeDashoffset: 1 - p,
});
