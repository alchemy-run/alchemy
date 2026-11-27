import { brand } from "../theme.ts";
import { Code, Lines, Panel, Rise, Scene } from "../ui.tsx";

const BUG = `decide: {
  WithdrawMoney: (account, cmd) =>
    cmd.amount > account.balance
    cmd.amount > account.balance + account.limit
      ? new InsufficientFunds()
      : [new MoneyWithdrawn({ amount: cmd.amount })],
},`;

/** Change the guard, and the same test names the state and command that break the rule. */
export const Broken = ({ length }: { length: number }) => (
  <Scene kicker="3 · Break it" title="Change one line, and it shows you the bug" length={length}>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      <div style={{ flex: 1.2 }}>
        <Panel title="Account.aggregate.ts">
          <Code code={BUG} at={4} every={2} size={24} struck={[2]} struckAt={40} added={[3]} />
        </Panel>
        <Rise at={62} style={{ fontSize: 28, color: brand.fgMuted, marginTop: 18 }}>
          An overdraft limit sounds harmless.
        </Rise>
      </div>
      <Rise at={96} style={{ flex: 1 }}>
        <Panel title="✗ Account.NeverOverdrawn: violated">
          <Lines
            at={104}
            every={12}
            size={26}
            lines={[
              { text: "state    { balance: 0, limit: 1 }", color: brand.fgMuted },
              { text: "command  WithdrawMoney { amount: 1 }", color: brand.gold },
              { text: "events   MoneyWithdrawn { amount: 1 }" },
              { text: "after    { balance: -1, limit: 1 }", color: brand.ember },
            ]}
          />
        </Panel>
        <Rise at={168} style={{ fontSize: 28, color: brand.fgMuted, marginTop: 18 }}>
          Found by the solver, then run on your real code.
        </Rise>
      </Rise>
    </div>
  </Scene>
);
