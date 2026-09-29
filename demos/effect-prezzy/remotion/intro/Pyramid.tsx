import { interpolate } from "remotion";
import type { PyramidStep } from "../../shared/intro.ts";
import { hand, mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { drawProgress, TONE } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Four bands, bottom first: slot 0 is the widest. */
const CX = 690;
const TOP = 196;
const BOTTOM = 944;
const WIDE = 1080;
const NARROW = 460;
const GAP = 12;
const SLOTS = 4;
const BAND = (BOTTOM - TOP - GAP * (SLOTS - 1)) / SLOTS;
const widthAt = (y: number) => NARROW + ((WIDE - NARROW) * (y - TOP)) / (BOTTOM - TOP);
const band = (slot: number) => {
  const bottom = BOTTOM - slot * (BAND + GAP);
  return { top: bottom - BAND, bottom, mid: bottom - BAND / 2 };
};
/** Where the notes beside the pyramid start. */
const NOTE_X = CX + WIDE / 2 + 70;

const DIM = 0.3;

/**
 * An application's layers, stacked as a pyramid. Layers rise in as they're
 * introduced; notes beside them and the bracket over them come and go by step.
 */
export const PyramidView = ({ step, prev, local }: { step: PyramidStep; prev?: PyramidStep; local: number }) => {
  const t = interpolate(local, [0, 10], [0, 1], clamp);
  const lit = (s: PyramidStep | undefined, id: string) => !s?.lit || s.lit.includes(id);
  const had = (id: string) => !!prev?.layers.some((l) => l.id === id);
  const fresh = step.layers.filter((l) => !had(l.id));
  const noteKey = (n: { layer: string; text: string }) => `${n.layer}:${n.text}`;
  const oldNotes = new Set(prev?.side?.map(noteKey));
  const newNotes = (step.side ?? []).filter((n) => !oldNotes.has(noteKey(n)));
  const braceNew = !!step.brace && (prev?.brace?.text !== step.brace.text || prev?.brace?.sub !== step.brace.sub);
  const braceWas = !!prev?.brace;

  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      {step.layers.map((layer, slot) => {
        const { top, bottom, mid } = band(slot);
        const k = fresh.indexOf(layer);
        const q = k < 0 ? 1 : interpolate(local, [k * 4, k * 4 + 8], [0, 1], clamp);
        const now = lit(step, layer.id) ? 1 : DIM;
        const then = had(layer.id) ? (lit(prev, layer.id) ? 1 : DIM) : now;
        const level = then + (now - then) * t;
        const wt = widthAt(top);
        const wb = widthAt(bottom);
        const oldDetail = prev?.layers.find((l) => l.id === layer.id)?.detail;
        const detailIn = oldDetail === undefined || oldDetail === layer.detail ? 1 : interpolate(local, [2, 10], [0, 1], clamp);
        return (
          <g key={layer.id} opacity={q * level} transform={`translate(0 ${(1 - q) * 30})`}>
            <path
              d={`M ${CX - wb / 2} ${bottom} L ${CX - wt / 2} ${top} L ${CX + wt / 2} ${top} L ${CX + wb / 2} ${bottom} Z`}
              fill={`${layer.color}1f`}
              stroke={layer.color}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <text x={CX} y={mid - 6} textAnchor="middle" fontFamily={sans} fontWeight={700} fontSize={40} fill={brand.fg}>
              {layer.title}
            </text>
            <text x={CX} y={mid + 38} textAnchor="middle" fontFamily={mono} fontSize={24} fill={brand.fgMuted} opacity={detailIn}>
              {layer.detail}
            </text>
          </g>
        );
      })}

      {(step.side ?? []).map((note) => {
        const slot = step.layers.findIndex((l) => l.id === note.layer);
        if (slot < 0) return null;
        const { mid } = band(slot);
        const k = newNotes.indexOf(note);
        const q = k < 0 ? 1 : interpolate(local, [4 + k * 4, 12 + k * 4], [0, 1], clamp);
        const color = TONE[note.tone ?? "neutral"];
        return (
          <g key={noteKey(note)} opacity={q} transform={`translate(${(1 - q) * 14} 0)`}>
            <text x={NOTE_X} y={mid + 14} fontFamily={hand} fontWeight={700} fontSize={44} fill={color}>
              {note.text}
            </text>
          </g>
        );
      })}

      {step.brace
        ? (() => {
            const shown = step.layers.length;
            const top = band(shown - 1).top;
            const bottom = BOTTOM;
            const x = NOTE_X - 20;
            const midY = (top + bottom) / 2;
            const p = braceNew && !braceWas ? drawProgress(local, 4, 12) : 1;
            const d = `M ${x} ${top} Q ${x + 28} ${top} ${x + 28} ${top + 40} L ${x + 28} ${midY - 30} Q ${x + 28} ${midY} ${x + 56} ${midY} Q ${x + 28} ${midY} ${x + 28} ${midY + 30} L ${x + 28} ${bottom - 40} Q ${x + 28} ${bottom} ${x} ${bottom}`;
            const label = braceNew ? interpolate(local, [8, 16], [0, 1], clamp) : 1;
            return (
              <g>
                <path
                  d={d}
                  fill="none"
                  stroke={TONE.good}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={3000}
                  strokeDashoffset={3000 * (1 - p)}
                />
                <g opacity={label}>
                  <text x={x + 84} y={midY - 4} fontFamily={hand} fontWeight={700} fontSize={54} fill={TONE.good}>
                    {step.brace.text}
                  </text>
                  {step.brace.sub
                    ? step.brace.sub.split("\n").map((line, i) => (
                        <text key={line} x={x + 86} y={midY + 44 + i * 40} fontFamily={mono} fontSize={26} fill={brand.fgMuted}>
                          {line}
                        </text>
                      ))
                    : null}
                </g>
              </g>
            );
          })()
        : null}
    </svg>
  );
};
