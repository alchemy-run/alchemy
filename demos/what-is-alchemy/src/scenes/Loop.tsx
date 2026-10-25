import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { color, font } from "../theme.ts";
import { Svg } from "../ui.tsx";

/** The compare page's testing loop: deploy → test → destroy → edit, in about 17 seconds. */
const STEPS = ["deploy", "test", "destroy", "edit"];
const C = { x: 620, y: 620 };
const R = 250;
const TEST = [
  "const stack = beforeAll(deploy(Stack));",
  "afterAll(destroy(Stack));",
  "",
  'test("stores a session", Effect.gen(function* () {',
  "  const { url } = yield* stack;",
  "  const res = yield* HttpClient.post(`${url}/session`);",
  "  expect(res.status).toBe(201);",
  "}));",
];

export const Loop = ({ t }: { t: number }) => {
  const around = progress(t, 6, 70);
  const angle = -Math.PI / 2 + around * Math.PI * 2;
  return (
    <AbsoluteFill>
      <Svg>
        <circle cx={C.x} cy={C.y} r={R} stroke={color.hairline} strokeWidth={3} fill="none" />
        <circle
          cx={C.x}
          cy={C.y}
          r={R}
          stroke={color.moss}
          strokeWidth={5}
          fill="none"
          transform={`rotate(-90 ${C.x} ${C.y})`}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - around}
        />
        <circle
          cx={C.x + Math.cos(angle) * R}
          cy={C.y + Math.sin(angle) * R}
          r={12}
          fill={color.moss}
        />
      </Svg>
      {STEPS.map((step, k) => {
        const a = -Math.PI / 2 + (k * Math.PI) / 2;
        const lit = around >= k / 4;
        return (
          <div
            key={step}
            style={{
              position: "absolute",
              left: C.x + Math.cos(a) * R,
              top: C.y + Math.sin(a) * R,
              transform: "translate(-50%, -50%)",
              padding: "10px 24px",
              borderRadius: 999,
              border: `2px solid ${lit ? color.moss : color.hairline}`,
              background: "#1d1a15",
              fontFamily: font.mono,
              fontSize: 26,
              color: lit ? color.fg : color.muted,
            }}
          >
            {step}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: C.x - 200,
          width: 400,
          top: C.y - 80,
          textAlign: "center",
        }}
      >
        <div style={{ fontFamily: font.serif, fontWeight: 600, fontSize: 110, color: color.fg }}>
          ~{Math.round(around * 17)}s
        </div>
        <div style={{ fontFamily: font.sans, fontSize: 24, color: color.muted }}>one full loop</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1020,
          top: 380,
          width: 780,
          padding: "26px 30px",
          boxSizing: "border-box",
          borderRadius: 16,
          border: `1px solid ${color.hairline}`,
          background: "#1a1713",
          fontFamily: font.mono,
          fontSize: 22,
          lineHeight: 1.65,
          color: color.fg,
          whiteSpace: "pre",
          opacity: progress(t),
        }}
      >
        <div style={{ color: color.muted, fontSize: 18, marginBottom: 12 }}>test/api.test.ts</div>
        {TEST.join("\n")}
      </div>
    </AbsoluteFill>
  );
};
