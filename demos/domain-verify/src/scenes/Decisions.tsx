import { brand } from "../theme.ts";
import { Caption, Code, Em, Lines, Panel, Rise, Scene } from "../ui.tsx";

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

/** A decision across instances, and the case a reader misses. */
export const Decisions = ({ length }: { length: number }) => (
  <Scene
    kicker="Decisions"
    title="A command decided across several instances is proved the same way"
    length={length}
  >
    <div style={{ display: "flex", gap: 36 }}>
      <Panel title="Charge.decision.ts" style={{ flex: 1.2 }}>
        <Code code={DECISION} at={12} size={22} lit={[1, 2]} litAt={170} />
      </Panel>
      <Rise at={110} style={{ flex: 1 }}>
        <Panel title="✗ Purse.NeverNegative: violated">
          <Lines
            at={120}
            every={12}
            size={22}
            lines={[
              { text: "state    first:  { balance: 1 }", color: brand.fgMuted },
              { text: "         second: { balance: 1 }", color: brand.fgMuted },
              { text: 'command  ChargeBoth { first: "a",', color: brand.gold },
              { text: '                      second: "a", fee: 1 }', color: brand.gold },
              { text: "events   Sent { 1 }, Sent { 1 }" },
              { text: "after    { balance: -1 }", color: brand.ember },
            ]}
          />
        </Panel>
        <Rise at={210} style={{ fontSize: 28, color: brand.fgMuted, marginTop: 20 }}>
          Both names are the same purse. It is checked for one fee and charged two.
        </Rise>
      </Rise>
    </div>
    <Caption at={240}>
      A decision must keep <Em>each aggregate's rules</Em> and its own rules about the instances
      together. Two names of one aggregate are tried as two instances, and as one.
    </Caption>
  </Scene>
);
