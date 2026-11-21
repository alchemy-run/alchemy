import type * as Domain from "@alchemy.run/domain";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";
import { AccountId } from "../src/Account/Account.id.ts";
import { DepositMoney } from "../src/Account/DepositMoney.command.ts";
import { FreezeAccount } from "../src/Account/FreezeAccount.command.ts";
import { OpenAccount } from "../src/Account/OpenAccount.command.ts";
import { MoneyWithdrawn, WithdrawMoney } from "../src/Account/WithdrawMoney.command.ts";
import { agent, customer } from "../src/Actor.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { CustomerId } from "../src/Customer/Customer.id.ts";

// Events on record are held against the account as it is written today: the
// states they lead through keep its rules, and each is one a command records.

const accountId = AccountId.make("a-1");
const ada = CustomerId.make("ada");
const start = DateTime.makeUnsafe("2026-03-01T09:00:00Z");

type Entry = Verify.HistoryEntry<Domain.Aggregate.EventOf<typeof Account>>;

/** A history as the bank would have recorded it: each command decided by the real account. */
const record = (
  commands: ReadonlyArray<{
    readonly command: Domain.Aggregate.CommandOf<typeof Account>;
    readonly by?: ReturnType<typeof customer>;
  }>,
) => {
  const entries: Array<Entry> = [];
  let state: Domain.Aggregate.StateOf<typeof Account> = Account.definition.initial;
  for (const [index, { command, by }] of commands.entries()) {
    const made = Account.predict(state, command as never, {
      now: DateTime.add(start, { minutes: index }),
      version: entries.length,
      commandId: `c-${index + 1}`,
      context: Context.make(CurrentActor, by ?? customer("ada")) as never,
    });
    if (made._tag !== "Accepted") continue;
    state = made.state;
    made.events.forEach((event, at) =>
      entries.push({ event, envelope: made.envelopes[at]! } as Entry),
    );
  }
  return entries;
};

const opened = [
  { command: new OpenAccount({ accountId, customerId: ada, owner: "Ada" }) },
  { command: new DepositMoney({ accountId, amount: 500 }) },
  { command: new WithdrawMoney({ accountId, amount: 120 }) },
];

it.effect(
  "what the bank recorded is what its commands record",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.history(Account, [
        ...record(opened),
        ...record([
          {
            command: new OpenAccount({
              accountId: AccountId.make("a-2"),
              customerId: ada,
              owner: "Ada",
            }),
          },
          {
            command: new FreezeAccount({ accountId: AccountId.make("a-2"), reason: "lost card" }),
            by: agent("sam"),
          },
        ]),
      ]);
      expect(report.instances).toMatchObject([
        { stream: "Account/a-1", events: 3, commands: 3, explained: 3, undecided: [] },
        { stream: "Account/a-2", events: 2, commands: 2, explained: 2, undecided: [] },
      ]);
      expect(report.instances[0]?.state).toMatchObject({ _tag: "Open", balance: 380 });
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a withdrawal the account would have refused is found among them",
  () =>
    Effect.gen(function* () {
      const history = record(opened);
      // Written past the account: more than it held leaves, and the balance is made up.
      const forged: Entry = {
        event: new MoneyWithdrawn({ amount: 900, balanceAfter: 10 }),
        envelope: { id: accountId, stream: "Account/a-1", seq: 4, commandId: "c-4" },
      };
      const failed = yield* Verify.history(Account, [...history, forged]).pipe(Effect.flip);
      if (failed._tag !== "NotVerified") return expect(failed._tag).toBe("NotVerified");
      expect(failed.report.unexplained).toHaveLength(1);
      expect(failed.report.unexplained[0]).toContain(
        "Account/a-1, event 4: MoneyWithdrawn { amount: 900, balanceAfter: 10 } from",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
