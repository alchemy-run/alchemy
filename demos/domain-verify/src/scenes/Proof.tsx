import { interpolate, useCurrentFrame } from "remotion";
import { brand, mono } from "../theme.ts";
import { Code, Lines, Panel, Rise, Scene, usePop } from "../ui.tsx";

const TEST = `it.effect("the account keeps its rules", () =>
  Verify.aggregate(Account),
);`;

/** One test: the code read as a formula, and a solver asked to break the rule. */
export const Proof = ({ length }: { length: number }) => {
  const frame = useCurrentFrame();
  const answer = usePop(190);
  const asking = frame >= 150 && frame < 190;
  return (
    <Scene kicker="2 · Prove it" title="One test. No inputs to write." length={length}>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <Panel title="Account.test.ts">
            <Code code={TEST} at={6} every={2} size={27} />
          </Panel>
          <Rise at={44} style={{ marginTop: 30 }}>
            <Panel title="your code, read as logic">
              <Lines
                at={52}
                every={11}
                size={25}
                lines={[
                  { text: "any state the rule allows     balance ≥ 0", color: brand.fgMuted },
                  {
                    text: "any command                   amount: any number",
                    color: brand.fgMuted,
                  },
                  { text: "decide records an event       amount ≤ balance" },
                  { text: "evolve                        balance′ = balance − amount" },
                  { text: "can the rule break?           balance′ < 0", color: brand.gold },
                ]}
              />
            </Panel>
          </Rise>
        </div>
        <div style={{ width: 520, textAlign: "center", marginTop: 20 }}>
          <Rise at={150}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 32,
                fontWeight: 700,
                color: brand.sky,
                border: `3px solid ${brand.sky}`,
                borderRadius: 20,
                padding: "20px 0",
                opacity: asking ? 0.6 + 0.4 * Math.sin(frame / 3) : 1,
              }}
            >
              Z3 solver
            </div>
          </Rise>
          <div
            style={{
              marginTop: 22,
              opacity: answer,
              transform: `scale(${interpolate(answer, [0, 1], [0.8, 1])})`,
            }}
          >
            <div style={{ fontSize: 64, fontWeight: 700, color: brand.moss }}>✓ Proved</div>
            <div style={{ fontSize: 26, color: brand.fgMuted, marginTop: 4 }}>
              every state, every input
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
};
