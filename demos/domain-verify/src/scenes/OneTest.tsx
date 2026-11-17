import { brand } from "../theme.ts";
import { Caption, Code, Em, Panel, Rise, Scene } from "../ui.tsx";

const TEST = `it.effect("the bank keeps its promises", () =>
  Verify.model(Bank, {
    apis: [CustomerApi, SupportApi],
    story,
  }).pipe(Effect.provide(NodeServices.layer)),
);`;

/** The one call, and the three things it does. */
export const OneTest = ({ length }: { length: number }) => (
  <Scene kicker="Step 2" title="One test verifies all of it" length={length}>
    <Panel title="Bank.verify.test.ts" style={{ width: 1100 }}>
      <Code code={TEST} at={12} size={30} />
    </Panel>
    <div style={{ display: "flex", gap: 28, marginTop: 44 }}>
      {[
        ["Prove", "what a solver can decide", brand.moss],
        ["Search", "every short sequence of commands", brand.gold],
        ["Run", "what it finds, on the real model", brand.sky],
      ].map(([name, what, color], index) => (
        <Rise key={name} at={70 + index * 20} style={{ flex: 1 }}>
          <div style={{ borderLeft: `6px solid ${color}`, paddingLeft: 24 }}>
            <div style={{ fontSize: 44, fontWeight: 700, color }}>{name}</div>
            <div style={{ fontSize: 28, color: brand.fgMuted, marginTop: 6 }}>{what}</div>
          </div>
        </Rise>
      ))}
    </div>
    <Caption at={140}>
      It reads your TypeScript and <Em>picks every value itself</Em>. Nobody writes an amount to
      withdraw or an order to send commands in.
    </Caption>
  </Scene>
);
