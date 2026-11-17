import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.context.ts";
import { CustomerId } from "../CustomerId.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Account } from "./Account.aggregate.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

const setBalance = <V extends { balance: number }>(v: V, e: { readonly balanceAfter: number }) => ({
  ...v,
  balance: e.balanceAfter,
});

/** The balance of one account, and how many times it changed. */
export class AccountSummary extends Domain.View("AccountSummary", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({
    customerId: Schema.NullOr(CustomerId),
    name: Schema.NullOr(Schema.String),
    balance: Cents,
    movements: Schema.Int,
  }),
  initial: { customerId: null, name: null, balance: 0, movements: 0 },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, customerId: e.customerId, name: e.name }),
    MoneyDeposited: (v, e) => ({ ...setBalance(v, e), movements: v.movements + 1 }),
    MoneyWithdrawn: (v, e) => ({ ...setBalance(v, e), movements: v.movements + 1 }),
    TransferDebited: (v, e) => ({ ...setBalance(v, e), movements: v.movements + 1 }),
    TransferCredited: (v, e) => ({ ...setBalance(v, e), movements: v.movements + 1 }),
    TransferRefunded: (v, e) => ({ ...setBalance(v, e), movements: v.movements + 1 }),
  },
}) {}

/**
 * Only the account's owner may read it. An account that isn't open yet
 * reads as empty, so a client can wait for it to appear.
 */
export const AccountSummaryLive = AccountSummary.toLayer(
  Effect.succeed(
    Effect.fn(function* (_request, summary) {
      const actor = yield* CurrentActor;
      const owner = summary?.customerId ?? null;
      if (owner === null || actor._tag === "System") return;
      if (owner !== actor.customerId) return yield* new NotOwner();
    }),
  ),
);
