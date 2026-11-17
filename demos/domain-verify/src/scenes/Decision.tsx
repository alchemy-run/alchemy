import { brand } from "../theme.ts";
import { Code, Lines, Panel, Rise, Scene } from "../ui.tsx";

const DECISION = `export class Charge extends Domain.Decision(ChargeBoth, {
  reads: { first: Purse, second: Purse },
  keyOf: (cmd) => ({ first: cmd.first, second: cmd.second }),
  decide: ({ first, second }, cmd) =>
    cmd.fee > first.state.balance ||
    cmd.fee > second.state.balance
      ? new NotEnough()
      : [
          first.record(new Sent({ amount: cmd.fee })),
          second.record(new Sent({ amount: cmd.fee })),
        ],
}) {}`;

/** A decision across two instances, and the case a reviewer misses. */
export const Decision = ({ length }: { length: number }) => (
  <Scene kicker="4 · Across instances" title="It finds the case you would not test" length={length}>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      <Panel title="Charge.decision.ts" style={{ flex: 1.25 }}>
        <Code code={DECISION} at={4} every={2} size={22} marks={[{ lines: [1, 2], from: 150 }]} />
      </Panel>
      <Rise at={70} style={{ flex: 1 }}>
        <Panel title="✗ Purse.NeverNegative: violated">
          <Lines
            at={78}
            every={10}
            size={23}
            lines={[
              { text: "state    first:  { balance: 1 }", color: brand.fgMuted },
              { text: "         second: { balance: 1 }", color: brand.fgMuted },
              { text: 'command  ChargeBoth { first: "a",', color: brand.gold },
              { text: '                     second: "a", fee: 1 }', color: brand.gold },
              { text: "after    { balance: -1 }", color: brand.ember },
            ]}
          />
        </Panel>
        <Rise at={150} style={{ fontSize: 30, color: brand.fg, marginTop: 20 }}>
          Both names are the same purse.
        </Rise>
        <Rise at={166} style={{ fontSize: 30, color: brand.fgMuted }}>
          Checked for one fee, charged two.
        </Rise>
      </Rise>
    </div>
  </Scene>
);
