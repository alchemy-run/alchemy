import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { code } from "../code.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";
import { drawn, span, Svg, Window } from "../ui.tsx";

type Props = { scene: Extract<Scene, { kind: "oneLine" }>; prev?: Scene; t: number };

const win = { x: 120, y: 250, fs: 19, code: code.jobs };
const LINE = "AWS.DynamoDB.GetItem(Jobs)";
const CARDS = [
  {
    label: "IAM policy",
    lines: ["Effect: Allow", "Action: dynamodb:GetItem", "Resource: arn:…:table/Jobs-a1b2c3"],
  },
  { label: "Environment", lines: ["Jobs_tableName: Jobs-a1b2c3"] },
  {
    label: "Typed client",
    lines: ["getItem: (request: GetItemRequest)", "  => Effect<GetItemOutput, GetItemError>"],
  },
];
const CARD = { x: 1180, w: 620, h: 196, gap: 34, y: 250 };

/** "One line does three jobs": the capability line and what it produces. */
export const OneLine = ({ scene, prev, t }: Props) => {
  const before = prev?.kind === "oneLine" ? prev.stage : 0;
  const lit = before >= 1 ? 1 : progress(t, 6, 14);
  const line = span(win, LINE);
  return (
    <AbsoluteFill>
      <Window
        {...win}
        w={980}
        file="src/api.ts"
        lit={[{ find: LINE, color: color.moss, p: lit }]}
        dim={lit}
      />
      {scene.stage === 2 &&
        CARDS.map((card, k) => {
          const p = progress(t, 4 + k * 8, 16);
          const y = CARD.y + k * (CARD.h + CARD.gap);
          return (
            <div key={card.label}>
              <Svg>
                <path
                  d={`M ${line.x2 + 12} ${line.mid} C ${line.x2 + 140} ${line.mid}, ${CARD.x - 120} ${y + CARD.h / 2}, ${CARD.x - 8} ${y + CARD.h / 2}`}
                  stroke={color.moss}
                  strokeWidth={3}
                  fill="none"
                  strokeLinecap="round"
                  {...drawn(p)}
                />
              </Svg>
              <div
                style={{
                  position: "absolute",
                  left: CARD.x,
                  top: y,
                  width: CARD.w,
                  height: CARD.h,
                  boxSizing: "border-box",
                  padding: "22px 28px",
                  borderRadius: 16,
                  border: `2px solid ${color.moss}`,
                  background: `color-mix(in srgb, ${color.moss} 8%, #1a1713)`,
                  opacity: progress(t, 10 + k * 8, 12),
                }}
              >
                <div
                  style={{
                    fontFamily: font.mono,
                    fontSize: 18,
                    letterSpacing: "0.2em",
                    color: color.moss,
                  }}
                >
                  {card.label.toUpperCase()}
                </div>
                {card.lines.map((l) => (
                  <div
                    key={l}
                    style={{
                      fontFamily: font.mono,
                      fontSize: 23,
                      color: color.fg,
                      marginTop: 12,
                      whiteSpace: "pre",
                    }}
                  >
                    {l}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </AbsoluteFill>
  );
};
