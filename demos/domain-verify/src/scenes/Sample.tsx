import { interpolate, useCurrentFrame } from "remotion";
import { brand } from "../theme.ts";
import { Caption, Code, Em, Panel, Rise, Scene } from "../ui.tsx";

const STORY = `story(
  Story.when(new Place({ id: "A", total: 100 })),
  Story.call(Risk.score, {}),
  Story.succeed(Risk.score, { risk: 1.5 }),
  Story.then(
    Order.ref("A"),
    new OrderPlaced({ total: 100 }),
    new OrderHeld({}),
  ),
)`;

/** A walk of commands picked at random, drawn a step at a time. */
const Walk = ({ at, seed, y }: { at: number; seed: number; y: number }) => {
  const frame = useCurrentFrame();
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const points = Array.from({ length: 12 }, (_, index) => ({
    x: 30 + index * 62,
    y: y + (next() - 0.5) * 70,
  }));
  const shown = (index: number) =>
    interpolate(frame, [at + index * 5, at + index * 5 + 8], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  return (
    <>
      {points.slice(1).map((point, index) => (
        <line
          key={`line${index}`}
          x1={points[index]!.x}
          y1={points[index]!.y}
          x2={point.x}
          y2={point.y}
          stroke={brand.border}
          strokeWidth={3}
          opacity={shown(index + 1)}
        />
      ))}
      {points.map((point, index) => (
        <circle
          key={`dot${index}`}
          cx={point.x}
          cy={point.y}
          r={11}
          fill={brand.sky}
          opacity={shown(index)}
        />
      ))}
    </>
  );
};

/** Past the short sequences: random walks, and the real model. */
export const Sample = ({ length }: { length: number }) => (
  <Scene
    kicker="Techniques 3 and 4 · Sample, then run for real"
    title="Reach further, then run it all for real"
    length={length}
  >
    <div style={{ display: "flex", gap: 40 }}>
      <div style={{ flex: 1 }}>
        <Panel title="200 walks of up to 12 commands, from a fixed seed">
          <svg width={760} height={330}>
            <Walk at={16} seed={7} y={60} />
            <Walk at={40} seed={21} y={165} />
            <Walk at={64} seed={99} y={270} />
          </svg>
        </Panel>
        <Rise at={110} style={{ fontSize: 28, color: brand.fgMuted, marginTop: 20 }}>
          A rule that takes five commands to break is out of reach of every sequence of two. The
          same seed gives the same walks, so a failure repeats.
        </Rise>
      </div>
      <Rise at={150} style={{ flex: 1 }}>
        <Panel title="each sequence found, as a story on the real model">
          <Code code={STORY} at={160} size={24} />
        </Panel>
        <Rise at={235} style={{ fontSize: 30, fontWeight: 600, color: brand.moss, marginTop: 20 }}>
          ✓ the model does what the explorer read
        </Rise>
      </Rise>
    </div>
    <Caption at={250}>
      The search reads your policies and sagas from source. Running each sequence as a{" "}
      <Em>story</Em> checks that it read them right, and gives you a test to keep.
    </Caption>
  </Scene>
);
