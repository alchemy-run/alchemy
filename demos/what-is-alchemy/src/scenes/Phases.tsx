import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { code } from "../code.ts";
import type { Scene } from "../scene.ts";
import { color, font, tone } from "../theme.ts";
import { Window } from "../ui.tsx";

type Props = { scene: Extract<Scene, { kind: "phases" }>; prev?: Scene; t: number };

const RUNTIME_LINES = [
  "fetch: Effect.gen",
  "const obj",
  "return obj",
  "? HttpServerResponse",
  ': HttpServerResponse.text("Not found"',
];
const TL = { x: 1130, w: 670, construct: 360, runtime: 640 };

/** The two phases: the code that asks for what it needs, and the code that runs per request. */
export const Phases = ({ scene, prev, t }: Props) => {
  const was = prev?.kind === "phases" ? prev.stage : 0;
  const construct = was >= 1 ? 1 : progress(t, 4, 14);
  const runtime = scene.stage < 2 ? 0 : was >= 2 ? 1 : progress(t, 4, 14);
  const requests = 9;
  return (
    <AbsoluteFill>
      <Window
        x={120}
        y={250}
        w={900}
        fs={21}
        file="src/api.ts"
        code={code.api}
        dim={construct}
        lit={[
          { find: "const bucket", color: tone.construct, p: construct },
          ...RUNTIME_LINES.map((find) => ({ find, color: tone.runtime, p: runtime })),
        ]}
      />
      {[
        {
          label: "Construction",
          sub: "when you deploy, and when the Worker starts",
          y: TL.construct,
          c: tone.construct,
          p: construct,
        },
        { label: "Runtime", sub: "once per request", y: TL.runtime, c: tone.runtime, p: runtime },
      ].map((row) => (
        <div
          key={row.label}
          style={{ position: "absolute", left: TL.x, top: row.y - 110, opacity: row.p }}
        >
          <div style={{ fontFamily: font.serif, fontWeight: 600, fontSize: 40, color: row.c }}>
            {row.label}
          </div>
          <div style={{ fontFamily: font.sans, fontSize: 22, color: color.muted, marginTop: 6 }}>
            {row.sub}
          </div>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: TL.x,
          top: TL.construct,
          width: 150,
          height: 56,
          borderRadius: 10,
          background: `color-mix(in srgb, ${tone.construct} 40%, transparent)`,
          border: `2px solid ${tone.construct}`,
          fontFamily: font.mono,
          fontSize: 20,
          color: color.fg,
          display: "grid",
          placeItems: "center",
          opacity: construct,
          transform: `scaleX(${construct})`,
          transformOrigin: "left",
        }}
      >
        once
      </div>
      {Array.from({ length: requests }, (_, k) => {
        const p = scene.stage < 2 ? 0 : was >= 2 ? 1 : progress(t, 8 + k * 3, 8);
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: TL.x + 170 + k * 56,
              top: TL.runtime,
              width: 40,
              height: 56,
              borderRadius: 8,
              background: `color-mix(in srgb, ${tone.runtime} 45%, transparent)`,
              border: `2px solid ${tone.runtime}`,
              opacity: p,
              transform: `translateY(${(1 - p) * -20}px)`,
            }}
          />
        );
      })}
      <div
        style={{
          position: "absolute",
          left: TL.x,
          top: TL.runtime + 100,
          width: TL.w,
          borderTop: `2px solid ${color.hairline}`,
          paddingTop: 10,
          fontFamily: font.mono,
          fontSize: 20,
          color: color.muted,
          opacity: construct,
        }}
      >
        time →
      </div>
    </AbsoluteFill>
  );
};
