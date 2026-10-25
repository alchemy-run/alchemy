import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class Opened extends Domain.Event("Opened") {}
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Open extends Domain.Command("Open", { target: Schema.String, events: [Opened] }) {}
// `decide` has a bug: it records a deposit even when the account is not open.
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean, balance: Schema.Number }),
  initial: { open: false, balance: 0 },
  commands: [Open, Deposit],
  decide: {
    Open: () => [new Opened()],
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
  },
  evolve: {
    Opened: (s) => ({ ...s, open: true }),
    Deposited: (s, e) => {
      if (!s.open) throw new Error("a deposit to an account that is not open");
      return { ...s, balance: s.balance + e.amount };
    },
  },
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}

describe("Domain Aggregate", () => {
  it.effect("a throw in evolve kills the command and commits nothing", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      const a1 = Account.ref("a-1");
      const exit = yield* Effect.exit(accounts.send(a1, new Deposit({ amount: 5 })));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(String(exit)).toContain("a deposit to an account that is not open");
      expect(yield* accounts.state(a1)).toEqual({ open: false, balance: 0 });
      // The next command starts from version 0: the deposit recorded no event.
      const opened = yield* accounts.send(a1, new Open());
      expect(opened.version).toBe(1);
    }).pipe(Effect.provide(Bank.layer(Layer.empty).pipe(Layer.provideMerge(InMemory)))),
  );
});
