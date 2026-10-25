import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { code } from "../code.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";
import { Window, windowHeight } from "../ui.tsx";

type Props = { scene: Extract<Scene, { kind: "layers" }>; prev?: Scene; t: number };

const VARIANTS = {
  kv: {
    label: "Cloudflare KV",
    layer: code.jobServiceKV,
    provide: "}).pipe(Effect.provide(JobServiceKV));",
  },
  dynamo: {
    label: "AWS DynamoDB",
    layer: code.jobServiceDynamo,
    provide: "}).pipe(Effect.provide(JobServiceDynamo));",
  },
};
const FS = 22;
const Y = 268;

/** A service whose Layer creates its own infrastructure; swapping the Layer moves it. */
export const Layers = ({ scene, prev, t }: Props) => {
  const now = VARIANTS[scene.variant];
  const was = prev?.kind === "layers" ? VARIANTS[prev.variant] : undefined;
  const roll = was && was !== now ? progress(t, 4, 14) : 1;
  const enterP = was ? 1 : progress(t);
  const usageY = Y + windowHeight(now.layer, FS) + 40;
  const at = scene.variant === "kv" ? 0 : 1;
  const from = was ? (was === VARIANTS.kv ? 0 : 1) : at;
  const slide = from + (at - from) * roll;
  return (
    <AbsoluteFill style={{ opacity: enterP }}>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 168,
          display: "flex",
          padding: 6,
          borderRadius: 999,
          border: `1px solid ${color.hairline}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 6 + slide * 250,
            width: 250,
            height: 52,
            borderRadius: 999,
            background: `color-mix(in srgb, ${color.moss} 22%, transparent)`,
            border: `2px solid ${color.moss}`,
            boxSizing: "border-box",
          }}
        />
        {[VARIANTS.kv, VARIANTS.dynamo].map((v) => (
          <div
            key={v.label}
            style={{
              position: "relative",
              width: 250,
              height: 52,
              display: "grid",
              placeItems: "center",
              fontFamily: font.sans,
              fontWeight: 600,
              fontSize: 24,
              color: v === now ? color.fg : color.muted,
            }}
          >
            {v.label}
          </div>
        ))}
      </div>
      <Window
        x={120}
        y={Y}
        w={1680}
        fs={FS}
        file="src/JobService.ts"
        code={now.layer}
        from={was?.layer}
        roll={roll}
      />
      <Window
        x={120}
        y={usageY}
        w={1680}
        fs={FS}
        file="src/api.ts"
        code={now.provide}
        from={was?.provide}
        roll={roll}
      />
    </AbsoluteFill>
  );
};
