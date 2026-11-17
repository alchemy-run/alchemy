import { brand } from "../theme.ts";
import { Code, Panel, Rise, Scene } from "../ui.tsx";

const ACCOUNT = `export class Account extends Domain.Aggregate("Account", {
  state: Schema.Struct({ balance: Schema.Number }),
  commands: [WithdrawMoney],
  decide: {
    WithdrawMoney: (account, cmd) =>
      cmd.amount > account.balance
        ? new InsufficientFunds()
        : [new MoneyWithdrawn({ amount: cmd.amount })],
  },
  evolve: {
    MoneyWithdrawn: (account, event) => ({
      balance: account.balance - event.amount,
    }),
  },
  invariants: {
    NeverOverdrawn: (account) => account.balance >= 0,
  },
}) {}`;

const NOTES = [
  { at: 70, color: brand.sky, name: "decide", what: "a command becomes events, or a rejection" },
  { at: 120, color: brand.gold, name: "evolve", what: "events fold into the next state" },
  { at: 170, color: brand.moss, name: "invariants", what: "what must be true of every state" },
] as const;

/** The whole model of an account, and the one rule about it. */
export const Write = ({ length }: { length: number }) => (
  <Scene kicker="1 · Model it" title="Plain functions, and one rule" length={length}>
    <div style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
      <Panel title="Account.aggregate.ts" style={{ flex: 1.5 }}>
        <Code
          code={ACCOUNT}
          at={8}
          every={2}
          size={24}
          marks={[
            { lines: [3, 4, 5, 6, 7, 8], from: 70 },
            { lines: [9, 10, 11, 12, 13], from: 120 },
            { lines: [14, 15, 16], from: 170 },
          ]}
        />
      </Panel>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24, marginTop: 8 }}>
        {NOTES.map((note) => (
          <Rise key={note.name} at={note.at}>
            <div style={{ borderLeft: `6px solid ${note.color}`, paddingLeft: 24 }}>
              <div style={{ fontSize: 40, fontWeight: 700, color: note.color }}>{note.name}</div>
              <div style={{ fontSize: 26, color: brand.fgMuted, marginTop: 2 }}>{note.what}</div>
            </div>
          </Rise>
        ))}
      </div>
    </div>
  </Scene>
);
