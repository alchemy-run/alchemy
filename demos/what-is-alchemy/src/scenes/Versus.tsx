import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { code } from "../code.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";
import { drawn, Pill, span, Svg, Window, windowHeight } from "../ui.tsx";

type Props = { scene: Extract<Scene, { kind: "versus" }>; prev?: Scene; t: number };

const FS = 17;
const L = 120;
const R = 1000;
const W = 800;
const TOP = 300;
const infra = { x: L, y: TOP, fs: FS, code: code.plain };
const handler = { x: L, y: TOP + windowHeight(code.plain, FS) + 24, fs: FS, code: code.plainApi };
const one = { x: R, y: TOP, fs: FS, code: code.api };

/** The compare page's side by side: two programs on the left, one Effect on the right. */
export const Versus = ({ scene, prev, t }: Props) => {
  const was = prev?.kind === "versus" ? prev.stage : 0;
  const at = (stage: number, delay = 0) =>
    scene.stage < stage ? 0 : was >= stage ? 1 : progress(t, delay, 16);
  const left = at(1);
  const link = at(2, 4);
  const right = at(3, 2);
  const from = span(infra, "env: { Uploads }");
  const to = span(handler, "env.Uploads");
  const label = (text: string, x: number, p: number, c: string) => (
    <div
      style={{
        position: "absolute",
        left: x,
        top: TOP - 52,
        fontFamily: font.serif,
        fontWeight: 600,
        fontSize: 34,
        color: c,
        opacity: p,
      }}
    >
      {text}
    </div>
  );
  return (
    <AbsoluteFill>
      {label("Other IaC tools: two programs", L, left, color.fg)}
      <div style={{ opacity: left * (1 - right * 0.45) }}>
        <Window
          {...infra}
          w={W}
          file="infra.ts"
          lit={[{ find: "env: { Uploads }", color: color.red, p: link }]}
        />
        <Window
          {...handler}
          w={W}
          file="src/api.ts"
          lit={[{ find: "env.Uploads", color: color.red, p: link }]}
        />
      </div>
      <Svg style={{ opacity: 1 - right * 0.45 }}>
        <path
          d={`M ${L - 6} ${from.mid} C ${L - 90} ${from.mid}, ${L - 90} ${to.mid}, ${L - 6} ${to.mid}`}
          stroke={color.red}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
          {...drawn(link)}
        />
      </Svg>
      <Pill
        color={color.red}
        style={{ left: L + W + 40, top: (from.mid + to.mid) / 2 - 24, opacity: link * (1 - right) }}
      >
        joined by one name
      </Pill>
      {label("Alchemy: Effects and Layers", R, right, color.moss)}
      <div style={{ opacity: right, transform: `translateX(${(1 - right) * 40}px)` }}>
        <Window
          {...one}
          w={W}
          file="src/api.ts"
          lit={[
            {
              find: "Cloudflare.R2.ReadWriteBucket(Uploads)",
              color: color.moss,
              p: progress(t, 14, 12) * (scene.stage === 3 ? 1 : 0),
            },
          ]}
        />
        <Pill
          color={color.moss}
          style={{
            left: R,
            top: one.y + windowHeight(code.api, FS) + 24,
            opacity: progress(t, 18, 12),
          }}
        >
          one line: access when you deploy, a typed client while it runs
        </Pill>
      </div>
    </AbsoluteFill>
  );
};
