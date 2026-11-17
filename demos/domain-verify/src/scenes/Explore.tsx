import { interpolate, useCurrentFrame } from "remotion";
import { brand, mono } from "../theme.ts";
import { Caption, Em, Lines, Panel, Rise, Scene } from "../ui.tsx";

const WIDTH = 860;
const HEIGHT = 350;
/** The column the level labels sit in, left of the tree. */
const LABELS = 150;

/** A tree of command sequences, drawn branch by branch. */
const Tree = ({ at }: { at: number }) => {
  const frame = useCurrentFrame();
  const levels = [1, 4, 12];
  const nodes = levels.flatMap((count, depth) =>
    Array.from({ length: count }, (_, index) => ({
      depth,
      index,
      x: LABELS + ((index + 0.5) / count) * (WIDTH - LABELS),
      y: 34 + depth * 140,
      parent: depth === 0 ? undefined : Math.floor(index / (count / levels[depth - 1]!)),
    })),
  );
  const shownAt = (depth: number, index: number) => at + depth * 40 + index * 4;
  return (
    <svg width={WIDTH} height={HEIGHT}>
      {nodes.map((node) => {
        if (node.parent === undefined) return null;
        const parent = nodes.find((n) => n.depth === node.depth - 1 && n.index === node.parent)!;
        const drawn = interpolate(
          frame,
          [shownAt(node.depth, node.index), shownAt(node.depth, node.index) + 14],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        return (
          <line
            key={`l${node.depth}-${node.index}`}
            x1={parent.x}
            y1={parent.y}
            x2={parent.x + (node.x - parent.x) * drawn}
            y2={parent.y + (node.y - parent.y) * drawn}
            stroke={brand.border}
            strokeWidth={3}
          />
        );
      })}
      {nodes.map((node) => {
        const shown = interpolate(
          frame,
          [shownAt(node.depth, node.index) + 8, shownAt(node.depth, node.index) + 18],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        // One sequence at the second level is the one that breaks a rule.
        const breaks = node.depth === 2 && node.index === 7;
        return (
          <circle
            key={`n${node.depth}-${node.index}`}
            cx={node.x}
            cy={node.y}
            r={(node.depth === 0 ? 20 : 15) * shown}
            fill={breaks && frame > at + 190 ? brand.ember : brand.gold}
          />
        );
      })}
      {["new model", "1 command", "2 commands"].map((label, depth) => (
        <text
          key={label}
          x={0}
          y={40 + depth * 140}
          fill={brand.fgMuted}
          fontFamily={mono}
          fontSize={19}
          opacity={interpolate(frame, [at + depth * 40, at + depth * 40 + 12], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        >
          {label}
        </text>
      ))}
    </svg>
  );
};

/** The search: every short sequence, with everything that follows from each. */
export const Explore = ({ length }: { length: number }) => (
  <Scene kicker="Technique 2 · Search" title="Run every short sequence of commands" length={length}>
    <div style={{ display: "flex", gap: 40 }}>
      <div style={{ width: WIDTH }}>
        <Tree at={14} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
          {[
            "policies and sagas react",
            "each event delivered twice",
            "reactions in other orders",
            "saga steps run twice",
            "schedules run late",
            "any answer an external system gives",
          ].map((fault, index) => (
            <Rise key={fault} at={120 + index * 10}>
              <div
                style={{
                  fontSize: 21,
                  color: brand.fg,
                  border: `1px solid ${brand.border}`,
                  borderRadius: 999,
                  padding: "7px 16px",
                  background: brand.bgElevated,
                }}
              >
                {fault}
              </div>
            </Rise>
          ))}
        </div>
      </div>
      <Rise at={204} style={{ flex: 1 }}>
        <Panel title="✗ Tickets.OneTicketPerSeat breaks">
          <Lines
            at={214}
            every={14}
            size={20}
            lines={[
              { text: '1. Seat "A" BookSeat  → SeatBooked' },
              { text: "   ↳ Issue asks Numbers.next  → C", color: brand.fgMuted },
              { text: '   ↳ Issue: Ticket "C" IssueTicket', color: brand.fgMuted },
              { text: "   ↳ Issue, handling its event again,", color: brand.ember },
              { text: "     asks Numbers.next  → E", color: brand.ember },
              { text: '   ↳ Issue again: Ticket "E" IssueTicket', color: brand.ember },
              { text: "" },
              { text: "Two tickets for one seat.", color: brand.fg },
            ]}
          />
        </Panel>
      </Rise>
    </div>
    <Caption at={330}>
      Checked means <Em>no sequence that was run</Em> breaks the rule. A break comes back as the
      shortest sequence, with the values the solver picked.
    </Caption>
  </Scene>
);
