import { AbsoluteFill, interpolate, useVideoConfig } from "remotion";
import type { CodeStep, Mark, Token } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand, vscode } from "../theme.ts";
import { DrillView } from "./Drill.tsx";
import { ReqView, reqHeight } from "./Req.tsx";
import { MiniGraphView } from "./MiniGraph.tsx";
import { boxPath, circlePath, drawProgress, stroke, strikePath, TONE, underlinePath } from "./draw.tsx";

/** The code canvas, inside the frame and above the caption band. */
/** Below the step title at the top of the frame. */
const AREA = { x: 110, y: 170, width: 1700, height: 870 };
const PANEL_WIDTH = 560;
/** Width kept for the drawing when a step has one. */
export const DIAGRAM_WIDTH = 760;
/** Left edge of the drawing (MiniGraph's area). */
const DRAWING_X = 1090;
const CHAR = 0.6;
const LINE = 1.55;

const lineText = (tokens: Token[]) => tokens.map((t) => t.text).join("");

/** Pixel geometry for the code block, centred in whatever space it gets. */
const layout = (step: CodeStep) => {
  const width =
    AREA.width - (step.diagram ? DIAGRAM_WIDTH + 60 : step.panel || step.drill || step.req || step.error ? PANEL_WIDTH + 60 : 0);
  const size = step.fontSize;
  const cw = size * CHAR;
  const lh = size * LINE;
  const longest = Math.max(...step.lines.map((l) => lineText(l).length), 1);
  const blockW = longest * cw;
  const blockH = step.lines.length * lh;
  // Code sits at the same left edge on every step, so it never shifts sideways
  // when a panel comes or goes. Only a one-line hero snippet is centred.
  const left = step.lines.length > 1 ? AREA.x + 30 : AREA.x + Math.max(0, (width - blockW) / 2);
  // With a drawing the program grows over several steps: pin its first line
  // so new lines extend downward instead of pushing the code up.
  // Code always starts at the same spot under its label; only a one-line hero is centred.
  const top =
    step.diagram || step.lines.length > 1 ? AREA.y + 90 : AREA.y + 50 + Math.max(0, (AREA.height - 50 - blockH) / 2);
  return { size, cw, lh, left, top, blockW, blockH, width };
};

const rect = (step: CodeStep, g: ReturnType<typeof layout>, mark: { line: number; col: number; len: number }) => ({
  x: g.left + mark.col * g.cw,
  y: g.top + mark.line * g.lh,
  w: mark.len * g.cw,
  h: g.lh,
});

/**
 * Lines of the previous code step in the same group, matched to this step's
 * lines so unchanged lines glide from where they were.
 */
const matchLines = (prev: CodeStep | undefined, step: CodeStep) => {
  const from = new Map<number, number>();
  if (!prev || prev.group !== step.group) return from;
  const used = new Set<number>();
  const prevText = prev.lines.map(lineText);
  step.lines.forEach((line, i) => {
    const text = lineText(line);
    if (!text.trim()) return;
    let best = -1;
    for (let j = 0; j < prevText.length; j++) {
      if (used.has(j) || prevText[j] !== text) continue;
      if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
    }
    if (best >= 0) {
      used.add(best);
      from.set(i, best);
    }
  });
  return from;
};

/**
 * Changed lines that are a small edit of a previous line: the columns that
 * differ (in the new line), so only that span is highlighted and fades in.
 */
const modifiedLines = (prev: CodeStep, step: CodeStep, matched: Map<number, number>) => {
  const out = new Map<number, { from: number; start: number; end: number }>();
  const taken = new Set(matched.values());
  const prevText = prev.lines.map(lineText);
  step.lines.forEach((line, i) => {
    const text = lineText(line);
    if (matched.has(i) || !text.trim()) return;
    let best: { from: number; start: number; end: number; score: number } | undefined;
    prevText.forEach((old, j) => {
      if (taken.has(j) || !old.trim()) return;
      let pre = 0;
      while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
      let suf = 0;
      while (suf < old.length - pre && suf < text.length - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
      const score = pre + suf;
      // Mostly the same line, or the old line with something inserted into it.
      const insertion = score >= old.length && old.trim().length >= 2;
      if ((!insertion && score < Math.max(old.length, text.length) * 0.5) || text.length - suf <= pre) return;
      if (!best || score > best.score || (score === best.score && Math.abs(j - i) < Math.abs(best.from - i)))
        best = { from: j, start: pre, end: text.length - suf, score };
    });
    if (best) {
      taken.add(best.from);
      out.set(i, { from: best.from, start: best.start, end: best.end });
    }
  });
  return out;
};

/** Tokens split at a column range, so part of a line can be styled on its own. */
const sliceTokens = (tokens: Token[], start: number, end: number) => {
  const out: { token: Token; inside: boolean }[] = [];
  let col = 0;
  for (const token of tokens) {
    const a = col;
    const b = col + token.text.length;
    const cuts = [a, Math.min(Math.max(start, a), b), Math.min(Math.max(end, a), b), b];
    for (let k = 0; k < 3; k++) {
      if (cuts[k + 1]! > cuts[k]!)
        out.push({ token: { ...token, text: token.text.slice(cuts[k]! - a, cuts[k + 1]! - a) }, inside: k === 1 });
    }
    col = b;
  }
  return out;
};

const MarkView = ({ mark, g, step, progress, index }: { mark: Mark; g: ReturnType<typeof layout>; step: CodeStep; progress: number; index: number }) => {
  const r = rect(step, g, mark);
  const color = TONE[mark.tone ?? "construct"];
  const seed = index * 13 + mark.line * 7 + mark.col;
  let path: string;
  if (mark.kind === "circle") path = circlePath(r.x, r.y, r.w, r.h, seed);
  else if (mark.kind === "underline") path = underlinePath(r.x, r.y + r.h * 0.92, r.w, seed);
  else if (mark.kind === "strike") path = strikePath(r.x, r.y + r.h * 0.52, r.w, seed);
  else if (mark.kind === "box") {
    const lastLine = mark.toLine ?? mark.line;
    const w = mark.toLine
      ? Math.max(...step.lines.slice(mark.line, lastLine + 1).map((l) => lineText(l).length)) * g.cw - mark.col * g.cw
      : r.w;
    path = boxPath(r.x, r.y, w, (lastLine - mark.line + 1) * g.lh, seed);
  } else path = "";

  const labelPos = (() => {
    switch (mark.side ?? "right") {
      case "below":
        return { x: r.x + r.w / 2, y: r.y + r.h + (mark.kind === "circle" ? 34 : 22), anchor: "middle" as const };
      case "above":
        return { x: r.x + r.w / 2, y: r.y - (mark.kind === "circle" ? 30 : 16), anchor: "middle" as const };
      case "left":
        return { x: r.x - 40, y: r.y + r.h / 2 + 10, anchor: "end" as const };
      default: {
        // Past the end of the line, so the label never sits on code.
        const lineEnd = g.left + lineText(step.lines[mark.line] ?? []).length * g.cw;
        const x = Math.max(r.x + r.w + (mark.kind === "circle" ? 44 : 28), lineEnd + 36);
        return { x, y: r.y + r.h / 2 + 10, anchor: "start" as const };
      }
    }
  })();
  const labelIn = interpolate(progress, [0.55, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <g>
      {mark.kind === "highlight" ? (
        <rect x={r.x - 8} y={r.y + 4} width={(r.w + 16) * progress} height={r.h - 8} rx={6} fill={color} opacity={0.22} />
      ) : (
        stroke(path, color, progress, mark.kind === "strike" ? 5 : 4)
      )}
      {mark.label ? (
        <text
          x={labelPos.x}
          y={labelPos.y}
          textAnchor={labelPos.anchor}
          fill={color}
          fontFamily={hand}
          fontWeight={700}
          fontSize={Math.min(52, Math.max(34, g.size * 1.05))}
          opacity={labelIn}
          stroke={brand.bg}
          strokeWidth={12}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {mark.label}
        </text>
      ) : null}
    </g>
  );
};

export const CodeSlide = ({
  step,
  prev,
  prev2,
  local,
}: {
  step: CodeStep;
  prev?: CodeStep;
  /** The step before `prev`: what was dimmed and drawn when this step began. */
  prev2?: CodeStep;
  local: number;
}) => {
  const { fps } = useVideoConfig();
  const g = layout(step);
  const morph = prev && prev.group === step.group;
  const matched = matchLines(morph ? prev : undefined, step);
  const pg = prev ? layout(prev) : g;
  const t = morph
    ? interpolate(local, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (x) => 1 - (1 - x) ** 3 })
    : interpolate(local, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const newIn = morph ? interpolate(local, [2, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : t;
  const marksStart = morph ? 6 : 4;

  // Lines new or changed since the previous step stay bright; the rest dims.
  // Each line moves from how bright it was at the end of the previous step.
  // Only an edit gets highlighted: when most of the code is new, it's a different snippet.
  const isEdit = (from: CodeStep, to: CodeStep, m: Map<number, number>) =>
    m.size >= from.lines.filter((l) => lineText(l).trim()).length / 2 && to.lines.length > 0;
  const edit = !!morph && isEdit(prev!, step, matched);
  const changed = (i: number) => edit && !matched.has(i) && !!lineText(step.lines[i] ?? []).trim();
  const modified = edit ? modifiedLines(prev!, step, matched) : new Map<number, { from: number; start: number; end: number }>();
  const anyChanged = step.tints.length === 0 && !step.quiet && step.lines.some((_, i) => changed(i));
  const morph2 = !!prev && !!prev2 && prev.group === step.group && prev2.group === prev.group;
  const prevMatched = morph2 ? matchLines(prev2, prev!) : new Map<number, number>();
  const prevEdit = morph2 && isEdit(prev2!, prev!, prevMatched);
  const prevChanged = (j: number) => prevEdit && !prevMatched.has(j) && !!lineText(prev!.lines[j] ?? []).trim();
  const prevAny = morph2 && prev!.tints.length === 0 && !prev!.quiet && prev!.lines.some((_, j) => prevChanged(j));
  const dimT = interpolate(local, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lineLevel = (i: number) => {
    const target = anyChanged ? (changed(i) ? 1 : 0.4) : 1;
    const from = matched.get(i);
    const start = from === undefined ? target : prevAny ? (prevChanged(from) ? 1 : 0.4) : 1;
    return start + (target - start) * dimT;
  };
  // A mark already drawn in the previous step stays drawn instead of redrawing.
  const sameMark = (m: Mark) =>
    !!morph &&
    prev!.marks.some(
      (p) => p.kind === m.kind && lineText(prev!.lines[p.line] ?? []).slice(p.col, p.col + p.len) === lineText(step.lines[m.line] ?? []).slice(m.col, m.col + m.len),
    );

  const tintOf = (i: number) => step.tints.find((tint) => i >= tint.from && i <= tint.to);
  const focused = (i: number) => !step.focus || (i >= step.focus.from && i <= step.focus.to);

  return (
    <AbsoluteFill>
      {step.file || step.pseudo ? (
        <div
          style={{
            position: "absolute",
            left: AREA.x,
            top: AREA.y,
            display: "flex",
            alignItems: "center",
            gap: 12,
            // What the code is: the imaginary language, or the file being shown.
            fontFamily: mono,
            fontSize: 22,
            color: brand.fgMuted,
            // Continuing the same code: the label is already there.
            opacity: morph ? 1 : t,
          }}
        >
          {step.pseudo ? "an imaginary cloud language" : step.file}
        </div>
      ) : null}
      {step.diagram ? (
        <div
          style={{
            position: "absolute",
            left: DRAWING_X,
            top: AREA.y,
            fontFamily: mono,
            fontSize: 22,
            color: brand.fgMuted,
            opacity: morph ? 1 : t,
          }}
        >
          the cloud
        </div>
      ) : null}
      {/* lines new or changed since the previous step in this sequence, in diff green */}
      {/* Steps that tint phases are about the phases, not the edit: no change highlight. */}
      {edit && step.tints.length === 0 && !step.quiet
        ? step.lines.map((tokens, i) => {
            if (matched.has(i) || !lineText(tokens).trim()) return null;
            const span = modified.get(i);
            if (span) {
              // An edit within the line: mark the line, highlight just the new part.
              return (
                <div key={`added-${i}`}>
                  <div
                    style={{
                      position: "absolute",
                      left: g.left - 26,
                      top: g.top + i * g.lh,
                      width: 4,
                      height: g.lh,
                      background: "#2ea043",
                      opacity: newIn,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: g.left + span.start * g.cw - 4,
                      top: g.top + i * g.lh + 3,
                      width: (span.end - span.start) * g.cw + 8,
                      height: g.lh - 6,
                      borderRadius: 5,
                      background: "rgba(46, 160, 67, 0.3)",
                      opacity: newIn,
                    }}
                  />
                </div>
              );
            }
            return (
              <div
                key={`added-${i}`}
                style={{
                  position: "absolute",
                  left: g.left - 26,
                  top: g.top + i * g.lh,
                  width: g.blockW + 52,
                  height: g.lh,
                  background: "rgba(46, 160, 67, 0.22)",
                  borderLeft: "4px solid #2ea043",
                  opacity: newIn,
                }}
              />
            );
          })
        : null}
      {/* phase tints: a bar in the gutter and a faint wash behind the lines */}
      {step.lines.map((_, i) => {
        const tint = tintOf(i);
        if (!tint) return null;
        return (
          <div
            key={`tint-${i}`}
            style={{
              position: "absolute",
              left: g.left - 26,
              top: g.top + i * g.lh,
              width: g.blockW + 40,
              height: g.lh,
              background: `linear-gradient(90deg, ${TONE[tint.tone]}26, ${TONE[tint.tone]}08 70%, transparent)`,
              borderLeft: `4px solid ${TONE[tint.tone]}`,
              opacity: newIn,
            }}
          />
        );
      })}
      {step.lines.map((tokens, i) => {
        const span = modified.get(i);
        // An edited line glides from its old position; only the new part fades in.
        const from = matched.get(i) ?? span?.from;
        const y0 = from !== undefined ? pg.top + from * pg.lh : g.top + i * g.lh;
        const x0 = from !== undefined ? pg.left : g.left;
        const y = y0 + (g.top + i * g.lh - y0) * t;
        const x = x0 + (g.left - x0) * t;
        const size = (from !== undefined ? pg.size : g.size) + (g.size - (from !== undefined ? pg.size : g.size)) * t;
        const opacity = (from !== undefined ? 1 : newIn) * (focused(i) ? 1 : 0.28) * lineLevel(i);
        const parts = span ? sliceTokens(tokens, span.start, span.end) : tokens.map((token) => ({ token, inside: false }));
        return (
          <div
            key={`line-${i}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              height: g.lh,
              lineHeight: `${g.lh}px`,
              fontFamily: mono,
              fontSize: size,
              whiteSpace: "pre",
              opacity,
            }}
          >
            {parts.map(({ token, inside }, k) => (
              <span key={k} style={{ color: token.color, opacity: inside ? newIn : 1 }}>
                {token.text}
              </span>
            ))}
          </div>
        );
      })}
      {step.error ? (
        <ErrorView
          step={step}
          g={g}
          local={local}
          delay={marksStart}
          minTop={step.req ? g.top + reqHeight(step.req) + 20 : AREA.y}
        />
      ) : null}
      {step.req ? (
        <ReqView
          req={step.req}
          prev={prev?.req}
          x={AREA.x + AREA.width - PANEL_WIDTH}
          labelY={AREA.y}
          top={g.top}
          local={local}
          delay={marksStart}
        />
      ) : null}
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        {step.marks.map((mark, i) => (
          <MarkView key={i} mark={mark} g={g} step={step} index={i} progress={sameMark(mark) ? 1 : drawProgress(local, marksStart + i * 4, 9)} />
        ))}
      </svg>
      {step.diagram ? (
        <MiniGraphView
          graph={step.diagram}
          prev={morph ? prev?.diagram : undefined}
          prev2={morph && prev2?.group === step.group ? prev2.diagram : undefined}
          local={local}
          delay={marksStart}
        />
      ) : null}
      {step.drill ? (
        <DrillView
          drill={step.drill}
          x={AREA.x + AREA.width - PANEL_WIDTH}
          labelY={AREA.y}
          top={g.top}
          local={local}
          delay={marksStart + step.marks.filter((m) => !sameMark(m)).length * 4}
        />
      ) : null}
      {step.panel ? (
        <Panel step={step} local={local} delay={marksStart + step.marks.length * 4} fps={fps} />
      ) : null}
    </AbsoluteFill>
  );
};

const ErrorView = ({
  step,
  g,
  local,
  delay,
  minTop,
}: {
  step: CodeStep;
  g: ReturnType<typeof layout>;
  local: number;
  delay: number;
  minTop: number;
}) => {
  const error = step.error!;
  const r = rect(step, g, error);
  const p = drawProgress(local, delay, 8);
  const box = interpolate(local, [delay + 4, delay + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // A squiggle along the error range.
  const wave: string[] = [];
  for (let x = 0; x <= r.w * p; x += 6) wave.push(`${r.x + x},${r.y + r.h - 4 + (Math.floor(x / 6) % 2 ? 4 : 0)}`);
  const boxX = AREA.x + AREA.width - PANEL_WIDTH;
  const boxY = Math.min(Math.max(minTop, r.y - 40), AREA.y + AREA.height - 320);
  return (
    <>
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
        {wave.length > 1 ? <polyline points={wave.join(" ")} fill="none" stroke="#f14c4c" strokeWidth={2.5} /> : null}
        {box > 0 ? (
          <path
            d={`M ${r.x + r.w * 0.5} ${r.y + r.h + 2} C ${r.x + r.w * 0.5} ${r.y + r.h + 60}, ${boxX - 80} ${boxY + 30}, ${boxX - 8} ${boxY + 30}`}
            fill="none"
            stroke="#f14c4c"
            strokeWidth={2}
            strokeDasharray="6 6"
            opacity={box}
          />
        ) : null}
      </svg>
      <div
        style={{
          position: "absolute",
          left: boxX,
          top: boxY,
          width: PANEL_WIDTH,
          padding: "14px 18px",
          background: "#252526",
          border: "1px solid #454545",
          borderRadius: 6,
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          fontFamily: mono,
          fontSize: 21,
          lineHeight: 1.5,
          color: "#cccccc",
          whiteSpace: "pre-wrap",
          opacity: box,
          transform: `translateY(${(1 - box) * 8}px)`,
        }}
      >
        {error.message.map((line, i) => (
          <div key={i} style={{ paddingLeft: i * 18, color: i === error.message.length - 1 ? "#ffffff" : "#cccccc" }}>
            {line}
          </div>
        ))}
        <div style={{ marginTop: 6, color: "#9d9d9d", fontFamily: sans, fontSize: 15 }}>{error.code}</div>
      </div>
    </>
  );
};

const Panel = ({ step, local, delay }: { step: CodeStep; local: number; delay: number; fps: number }) => {
  const panel = step.panel!;
  const x = AREA.x + AREA.width - PANEL_WIDTH;
  const inAt = (i: number) =>
    interpolate(local, [delay + i * 3, delay + i * 3 + 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: AREA.y,
        width: PANEL_WIDTH,
        height: AREA.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 22,
        fontFamily: sans,
      }}
    >
      <div
        style={{
          fontFamily: hand,
          fontWeight: 700,
          fontSize: 40,
          color: TONE.construct,
          opacity: inAt(0),
        }}
      >
        {panel.title}
      </div>
      {panel.items.map((item, i) => {
        const color = TONE[item.tone ?? "neutral"];
        const p = inAt(i + 1);
        return (
          <div key={i} style={{ opacity: p, transform: `translateX(${(1 - p) * 20}px)` }}>
            <div style={{ color: item.tone ? color : brand.fg, fontSize: 24, fontWeight: 600 }}>{item.title}</div>
            {item.body ? <div style={{ color: brand.fgMuted, fontSize: 20, marginTop: 4 }}>{item.body}</div> : null}
            {item.mono ? (
              <pre
                style={{
                  margin: "10px 0 0",
                  padding: "14px 16px",
                  background: vscode.editorBg,
                  border: `1px solid ${item.tone ? color : "rgba(255,255,255,0.1)"}`,
                  borderRadius: 10,
                  fontFamily: mono,
                  fontSize: 18,
                  lineHeight: 1.45,
                  color: "#d4d4d4",
                  whiteSpace: "pre-wrap",
                }}
              >
                {item.mono}
              </pre>
            ) : null}
            {item.bar !== undefined ? (
              <div style={{ marginTop: 10, height: 18, borderRadius: 9, background: "rgba(255,255,255,0.06)" }}>
                <div
                  style={{
                    width: `${item.bar * 100 * p}%`,
                    minWidth: 10,
                    height: "100%",
                    borderRadius: 9,
                    background: color,
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
