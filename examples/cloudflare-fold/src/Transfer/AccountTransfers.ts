import { Event, View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.ts";
import { Cents } from "../Money.ts";
import { Transfer, type TransferRequested } from "./Transfer.ts";
import { TransferId } from "./TransferId.ts";

/** Money moved in or out of an account by a transfer. */
export class TransferMoved extends Event.make("TransferMoved", {
  data: {
    transferId: TransferId,
    amount: Cents,
    direction: Schema.Literals(["in", "out"]),
  },
}) {}

const moved = (direction: "in" | "out") => (e: TransferRequested) =>
  new TransferMoved({ transferId: e.transferId, amount: e.amount, direction });

/** Transfers touching an account. One request is routed to both accounts. */
export class AccountTransfers extends View.make("AccountTransfers", {
  from: [Transfer],
  key: Account,
  keyOf: {
    TransferRequested: {
      out: ({ event }) => Account.ref(event.from),
      in: ({ event }) => Account.ref(event.to),
    },
  },
  events: [TransferMoved],
  emit: {
    TransferRequested: { out: moved("out"), in: moved("in") },
  },
}) {}
