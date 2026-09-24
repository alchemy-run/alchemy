import { interpolate } from "remotion";
import type { ReqItem, ReqPanel } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { TONE } from "./draw.tsx";

/** Vertical space per requirement. */
export const REQ_ROW = 58;

/** The editor theme's colors for types and punctuation, so Req reads as code. */
const TYPE = "#4ec9b0";
const PUNCT = "#d4d4d4";
const SIZE = 26;

/** One member of the union: `| Name`, with a note beside it. */
const Row = ({ item }: { item: ReqItem }) => {
  const state = item.state ?? "open";
  const noteColor = state === "met" ? TONE.good : state === "bad" ? TONE.bad : brand.fgMuted;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
      <div style={{ fontFamily: mono, fontSize: SIZE, whiteSpace: "pre", opacity: state === "met" ? 0.45 : 1 }}>
        <span style={{ color: PUNCT }}>| </span>
        <span
          style={{
            color: state === "bad" ? TONE.bad : TYPE,
            textDecoration: state === "met" ? "line-through" : undefined,
            textDecorationColor: TONE.good,
            textDecorationThickness: 2,
          }}
        >
          {item.name}
        </span>
      </div>
      {item.note ? (
        <div style={{ fontFamily: sans, fontSize: 18, lineHeight: 1.35, color: noteColor, whiteSpace: "pre" }}>
          {state === "met" ? `✓ ${item.note}` : state === "bad" ? `✗ ${item.note}` : item.note}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The requirements (Effect's `Req`) of the code on screen, written as the
 * union type they are. A member that is new since the previous step slides
 * in; one whose state or note changed cross-fades; the rest stay still.
 */
export const ReqView = ({
  req,
  prev,
  x,
  labelY,
  top,
  local,
  delay,
}: {
  req: ReqPanel;
  prev?: ReqPanel;
  x: number;
  labelY: number;
  top: number;
  local: number;
  delay: number;
}) => {
  const p = interpolate(local, [delay, delay + 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const same = (a: ReqItem, b: ReqItem) => (a.state ?? "open") === (b.state ?? "open") && a.note === b.note;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: labelY,
          fontFamily: mono,
          fontSize: 22,
          color: brand.fgMuted,
          opacity: prev && prev.label === req.label ? 1 : p,
        }}
      >
        {req.label}
      </div>
      {req.items.length === 0 ? (
        <div
          style={{
            position: "absolute",
            left: x,
            top,
            fontFamily: mono,
            fontSize: SIZE,
            color: TYPE,
            opacity: prev && prev.items.length === 0 ? 1 : p,
          }}
        >
          never
        </div>
      ) : null}
      {req.items.map((item, i) => {
        const before = prev?.items.find((o) => o.name === item.name);
        const y = top + i * REQ_ROW;
        if (!before) {
          return (
            <div key={item.name} style={{ position: "absolute", left: x, top: y, opacity: p, transform: `translateX(${(1 - p) * 18}px)` }}>
              <Row item={item} />
            </div>
          );
        }
        if (same(before, item)) {
          return (
            <div key={item.name} style={{ position: "absolute", left: x, top: y }}>
              <Row item={item} />
            </div>
          );
        }
        return (
          <div key={item.name}>
            <div style={{ position: "absolute", left: x, top: y, opacity: 1 - p }}>
              <Row item={before} />
            </div>
            <div style={{ position: "absolute", left: x, top: y, opacity: p }}>
              <Row item={item} />
            </div>
          </div>
        );
      })}
    </>
  );
};
