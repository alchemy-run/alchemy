import { Caption, Code, Em, Panel, Scene } from "../ui.tsx";

const ACCOUNT = `export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: AccountState,
  invariants: {
    NeverOverdrawn: (account) =>
      account._tag !== "Open" || account.balance >= 0,
  },
  transitions: {
    AClosedAccountStaysClosed: ({ before, after }) =>
      before._tag !== "Closed" || after._tag === "Closed",
  },
  decide: { ... },
  evolve: { ... },
}) {}`;

const BANK = `export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, Account, Transfer],
  invariants: {
    NoTransferLeftPending: (bank) =>
      bank.Transfer.every(
        (t) => t.state._tag !== "Pending"),
  },
  eventually: {
    EveryTransferEnds: (bank) => ...,
  },
}) {}`;

/** Where rules are written: on the declaration, by name. */
export const Rules = ({ length }: { length: number }) => (
  <Scene kicker="Step 1" title="Say what must never happen" length={length}>
    <div style={{ display: "flex", gap: 36 }}>
      <Panel title="Account.aggregate.ts" style={{ flex: 1.15 }}>
        <Code code={ACCOUNT} at={14} size={22} lit={[3, 4, 5, 6, 7, 8, 9, 10]} litAt={90} />
      </Panel>
      <Panel title="Bank.model.ts" style={{ flex: 1 }}>
        <Code code={BANK} at={150} size={22} lit={[2, 3, 4, 5, 6, 7, 8, 9]} litAt={215} />
      </Panel>
    </div>
    <Caption at={235}>
      An <Em>invariant</Em> is about a state. A <Em>transition</Em> is about one step. A{" "}
      <Em>model rule</Em> spans instances. Nothing runs them when a command arrives.
    </Caption>
  </Scene>
);
