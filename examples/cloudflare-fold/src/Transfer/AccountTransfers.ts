import { Feed } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.ts";
import { Cents } from "../Money.ts";
import { Transfer } from "./Transfer.ts";
import { TransferId } from "./TransferId.ts";

/** Transfers touching an account. One event fans out to both accounts. */
export class AccountTransfers extends Feed.make("AccountTransfers", {
  from: [Transfer],
  key: Account,
  keyOf: {
    TransferRequested: ({ event }) => [Account.ref(event.from), Account.ref(event.to)],
  },
  entry: Schema.Struct({
    transferId: TransferId,
    amount: Cents,
    direction: Schema.Literals(["in", "out"]),
  }),
  map: {
    TransferRequested: (e, { key }) => ({
      transferId: e.transferId,
      amount: e.amount,
      direction: key.id === e.from ? ("out" as const) : ("in" as const),
    }),
  },
}) {}
