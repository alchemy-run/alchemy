import { interpolate } from "remotion";
import type { ReqItem, ReqPanel } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { TONE } from "./draw.tsx";

/** Vertical space per requirement. */
export const REQ_ROW = 92;

const STYLE = {
  open: { color: TONE.neutral, icon: "○", border: "rgba(201, 193, 174, 0.45)" },
  met: { color: TONE.good, icon: "✓", border: TONE.good },
  bad: { color: TONE.bad, icon: "✗", border: TONE.bad },
} as const;

const Row = ({ item }: { item: ReqItem }) => {
  const s = STYLE[item.state ?? "open"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          border: `2px solid ${s.border}`,
          borderRadius: 10,
          background: "rgba(0, 0, 0, 0.25)",
          fontFamily: mono,
          fontSize: 26,
          color: brand.fg,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: s.color, fontWeight: 700 }}>{s.icon}</span>
        {item.name}
      </div>
      {item.note ? (
        <div style={{ fontFamily: sans, fontSize: 20, lineHeight: 1.35, color: brand.fgMuted, whiteSpace: "pre" }}>{item.note}</div>
      ) : null}
    </div>
  );
};

/**
 * The requirements (Effect's `Req`) of the code on screen. A requirement
 * that is new since the previous step slides in; one whose state or note
 * changed cross-fades; the rest stay still.
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
            fontSize: 26,
            fontStyle: "italic",
            color: brand.fgMuted,
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
