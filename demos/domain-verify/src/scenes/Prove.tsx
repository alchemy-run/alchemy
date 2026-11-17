import { interpolate, useCurrentFrame } from "remotion";
import { brand, mono } from "../theme.ts";
import { Caption, Code, Em, Lines, Panel, Rise, Scene, usePop } from "../ui.tsx";

const DECIDE = `decide: {
  WithdrawMoney: (account, cmd) =>
    cmd.amount > account.balance
      ? new InsufficientFunds()
      : [new MoneyWithdrawn({ amount: cmd.amount })],
},
evolve: {
  MoneyWithdrawn: (account, e) => ({
    balance: account.balance - e.amount,
  }),
},`;

/** The proof: code read as a formula, and a solver asked for a counterexample. */
export const Prove = ({ length }: { length: number }) => {
  const frame = useCurrentFrame();
  const answer = usePop(250);
  const asking = frame >= 196 && frame < 250;
  return (
    <Scene
      kicker="Technique 1 · Prove"
      title="Read the code as logic, and ask a solver for any case that breaks the rule"
      length={length}
    >
      <div style={{ display: "flex", gap: 36, alignItems: "flex-start" }}>
        <Panel title="your TypeScript" style={{ flex: 1.25 }}>
          <Code code={DECIDE} at={12} size={21} />
        </Panel>
        <Rise at={70} style={{ alignSelf: "center", fontSize: 60, color: brand.fgMuted }}>
          →
        </Rise>
        <Panel title="what the solver is asked" style={{ flex: 1 }}>
          <Lines
            at={84}
            every={16}
            size={25}
            lines={[
              { text: "any state the rules allow", color: brand.fgMuted },
              { text: "  balance ≥ 0" },
              { text: "any input the command takes", color: brand.fgMuted },
              { text: "  amount > 0" },
              { text: "the path that records an event", color: brand.fgMuted },
              { text: "  amount ≤ balance" },
              { text: "  balance′ = balance − amount" },
              { text: "can the rule be false after?", color: brand.gold },
              { text: "  balance′ < 0  ?", color: brand.gold },
            ]}
          />
        </Panel>
        <div style={{ width: 290, alignSelf: "center", textAlign: "center" }}>
          <Rise at={196}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 40,
                fontWeight: 700,
                color: brand.sky,
                border: `3px solid ${brand.sky}`,
                borderRadius: 20,
                padding: "26px 0",
                opacity: asking ? 0.6 + 0.4 * Math.sin(frame / 3) : 1,
              }}
            >
              Z3
            </div>
          </Rise>
          <div
            style={{
              marginTop: 26,
              opacity: answer,
              transform: `scale(${interpolate(answer, [0, 1], [0.8, 1])})`,
            }}
          >
            <div style={{ fontFamily: mono, fontSize: 30, color: brand.fgMuted }}>no such case</div>
            <div style={{ fontSize: 54, fontWeight: 700, color: brand.moss, marginTop: 6 }}>
              ✓ Proved
            </div>
          </div>
        </div>
      </div>
      <Caption at={280}>
        Proved means <Em>every state and every input</Em>, after any number of commands. If the
        solver finds a case, the real code is run on it, and only a real break counts.
      </Caption>
    </Scene>
  );
};
