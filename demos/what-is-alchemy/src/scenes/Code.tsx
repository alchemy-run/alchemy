import { AbsoluteFill } from "remotion";
import { enter, progress } from "../anim.ts";
import { highlightTs, highlightYaml } from "../highlight.ts";
import type { Mark, Pane, Scene } from "../scene.ts";
import { locate } from "../snippet.ts";
import { color, font, tone } from "../theme.ts";

type CodeScene = Extract<Scene, { kind: "code" }>;

const AREA = { x: 80, y: 150, w: 1760, h: 860 };
const GAP = 80;
const HEADER = 44;
const REEL = 70;

/** Where each pane sits and how big its text is: one size for the whole scene. */
const layout = (scene: CodeScene) => {
  const n = scene.panes.length;
  const h = AREA.h - HEADER - (scene.reel ? REEL : 0);
  const sizes = scene.panes.map((p) => {
    const lines = p.code.split("\n");
    return { lines: lines.length, cols: Math.max(...lines.map((l) => l.length)) + 2 };
  });
  // Side-by-side panes split the width by how wide their code is.
  const total = sizes.reduce((sum, s) => sum + s.cols, 0);
  const widths = sizes.map((s) => ((AREA.w - GAP * (n - 1)) * s.cols) / total);
  const fs = Math.min(
    32,
    ...sizes.map((s, i) => Math.min(widths[i]! / (s.cols * 0.6), h / (s.lines * 1.6))),
  );
  let x = AREA.x;
  return {
    fs,
    lh: fs * 1.6,
    // JetBrains Mono's advance is 0.6em.
    cw: fs * 0.6,
    panes: widths.map((w) => {
      const pane = { x, y: AREA.y + HEADER, w };
      x += w + GAP;
      return pane;
    }),
  };
};

const key = (m: { find?: string; from?: string; to?: string; label?: string; tone?: string }) =>
  JSON.stringify(m);

export const Code = ({ scene, prev, t }: { scene: CodeScene; prev?: Scene; t: number }) => {
  const before = prev?.kind === "code" && prev.group === scene.group ? prev : undefined;
  const { fs, lh, cw, panes } = layout(scene);
  const fresh = !before;
  const appear = fresh ? progress(t) : 1;
  /** New marks, tints and links draw in; ones already on screen stay put. */
  const isNew = (pane: number, item: object, list: "marks" | "tints" | "links") => {
    if (!before) return true;
    const old =
      list === "links" ? (before.links ?? []) : ((before.panes[pane]?.[list] ?? []) as object[]);
    return !old.some((o) => key(o) === key(item));
  };
  const draw = (isNewItem: boolean) => (isNewItem ? progress(t, fresh ? 10 : 2, 18) : 1);

  return (
    <AbsoluteFill style={enter(appear)}>
      {scene.panes.map((pane, i) => {
        const at = panes[i]!;
        const changed = before && before.panes[i]?.code !== pane.code;
        const lines = pane.code.split("\n");
        const tints = (pane.tints ?? []).map((tint) => ({
          tint,
          from: locate(pane.code, tint.from).line,
          to: tint.to ? locate(pane.code, tint.to).line : locate(pane.code, tint.from).line,
          p: draw(isNew(i, tint, "tints")),
        }));
        const dimmed = tints.length ? Math.max(...tints.map((x) => x.p)) : 0;
        return (
          <div key={i}>
            <div
              style={{
                position: "absolute",
                left: at.x,
                top: at.y - HEADER,
                fontFamily: font.mono,
                fontSize: 20,
                color: color.muted,
              }}
            >
              {pane.file}
            </div>
            {tints.map(({ tint, from, to, p }, k) => (
              <div
                key={k}
                style={{
                  position: "absolute",
                  left: at.x - 16,
                  top: at.y + from * lh,
                  width: at.w + 16,
                  height: (to - from + 1) * lh,
                  background: `${tone[tint.tone]}24`,
                  borderLeft: `4px solid ${tone[tint.tone]}`,
                  opacity: p,
                }}
              />
            ))}
            <div style={{ opacity: changed ? progress(t, 0, 10) : 1 }}>
              {lines.map((line, n) => {
                const lit = tints.some((x) => n >= x.from && n <= x.to);
                return (
                  <div
                    key={n}
                    style={{
                      position: "absolute",
                      left: at.x,
                      top: at.y + n * lh,
                      height: lh,
                      lineHeight: `${lh}px`,
                      fontFamily: font.mono,
                      fontSize: fs,
                      whiteSpace: "pre",
                      opacity: lit ? 1 : 1 - dimmed * 0.65,
                    }}
                  >
                    {(pane.lang === "yaml" ? highlightYaml(line) : highlightTs(line)).map(
                      (tok, k) => (
                        <span key={k} style={{ color: tok.color }}>
                          {tok.text}
                        </span>
                      ),
                    )}
                  </div>
                );
              })}
            </div>
            {(pane.marks ?? []).map((mark, k) => (
              <MarkView
                key={k}
                mark={mark}
                pane={pane}
                at={at}
                fs={fs}
                lh={lh}
                cw={cw}
                p={draw(isNew(i, mark, "marks"))}
              />
            ))}
          </div>
        );
      })}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {(scene.links ?? []).map((link, k) => {
          const a = scene.panes[0]!;
          const b = scene.panes[1]!;
          const from = locate(a.code, link.from);
          const to = locate(b.code, link.to);
          const x1 = panes[0]!.x + (from.col + from.len) * cw + 8;
          const y1 = panes[0]!.y + from.line * lh + lh * 0.5;
          const x2 = panes[1]!.x + to.col * cw - 8;
          const y2 = panes[1]!.y + to.line * lh + lh * 0.5;
          const mid = (x1 + x2) / 2;
          const p = draw(isNew(0, link, "links"));
          const stroke = tone[link.tone];
          const under = (x: number, y: number, len: number) =>
            `M ${x} ${y + lh * 0.42} L ${x + len * cw} ${y + lh * 0.42}`;
          return (
            <g key={k} stroke={stroke} strokeWidth={3} fill="none" strokeLinecap="round">
              <path
                d={under(
                  panes[0]!.x + from.col * cw,
                  panes[0]!.y + from.line * lh + lh / 2,
                  from.len,
                )}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
              />
              <path
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
              />
              <path
                d={under(panes[1]!.x + to.col * cw, panes[1]!.y + to.line * lh + lh / 2, to.len)}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
              />
            </g>
          );
        })}
      </svg>
      {scene.reel && <Reel reel={scene.reel} prev={before?.reel} t={t} />}
    </AbsoluteFill>
  );
};

/** A hand-drawn circle or underline on code, and its label. */
const MarkView = (p: {
  mark: Mark;
  pane: Pane;
  at: { x: number; y: number };
  fs: number;
  lh: number;
  cw: number;
  p: number;
}) => {
  const { line, col, len } = locate(p.pane.code, p.mark.find);
  const stroke = tone[p.mark.tone];
  const x = p.at.x + col * p.cw;
  const y = p.at.y + line * p.lh;
  const w = len * p.cw;
  const lineEnd = p.at.x + p.pane.code.split("\n")[line]!.length * p.cw;
  // An ellipse around the span from two cubics (control points at 4/3 of the
  // radius), not quite closed, like a pen stroke.
  const cx = x + w / 2;
  const r = (w / 2 + 16) * (4 / 3);
  const d =
    p.mark.kind === "circle"
      ? `M ${cx} ${y - 2} C ${cx + r} ${y - 4}, ${cx + r} ${y + p.lh + 4}, ${cx} ${y + p.lh + 2} C ${cx - r} ${y + p.lh}, ${cx - r} ${y - 6}, ${cx + 18} ${y}`
      : `M ${x} ${y + p.lh * 0.92} Q ${x + w / 2} ${y + p.lh * 1.02}, ${x + w} ${y + p.lh * 0.9}`;
  return (
    <>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <path
          d={d}
          stroke={stroke}
          strokeWidth={3.5}
          fill="none"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - p.p}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: lineEnd + 48,
          top: y - p.lh * 0.15,
          fontFamily: font.hand,
          fontWeight: 700,
          fontSize: p.fs * 1.35,
          lineHeight: `${p.lh * 1.3}px`,
          color: stroke,
          whiteSpace: "nowrap",
          opacity: p.p,
        }}
      >
        {p.mark.label}
      </div>
    </>
  );
};

/** The options under the code, with the lit one underlined; the underline slides on a change. */
const Reel = (p: {
  reel: { items: string[]; at: number };
  prev?: { items: string[]; at: number };
  t: number;
}) => {
  const step = 220;
  const from = p.prev?.at ?? p.reel.at;
  const x = (from + (p.reel.at - from) * progress(p.t, 0, 12)) * step;
  return (
    <div style={{ position: "absolute", left: AREA.x, top: AREA.y + AREA.h - 36, height: 60 }}>
      {p.reel.items.map((item, i) => (
        <span
          key={item}
          style={{
            position: "absolute",
            left: i * step,
            fontFamily: font.sans,
            fontWeight: 600,
            fontSize: 30,
            color: i === p.reel.at ? color.fg : color.muted,
            opacity: i === p.reel.at ? 1 : 0.6,
          }}
        >
          {item}
        </span>
      ))}
      <span
        style={{
          position: "absolute",
          left: x,
          top: 46,
          width: 150,
          height: 4,
          borderRadius: 2,
          background: color.moss,
        }}
      />
    </div>
  );
};
