import { View } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { Cents } from "../Money.ts";
import { Transfer } from "./Transfer.ts";

/**
 * The progress of one transfer, assembled from the Transfer and both
 * accounts. Each handler sets its own fact, so arrival order does not matter.
 */
export class TransferStatus extends View.make("TransferStatus", {
  from: [Transfer, Account],
  key: Transfer,
  keyOf: {
    TransferDebited: ({ event }) => Transfer.ref(event.transferId),
    TransferCredited: ({ event }) => Transfer.ref(event.transferId),
    TransferRefunded: ({ event }) => Transfer.ref(event.transferId),
  },
  state: Schema.Struct({
    from: Schema.NullOr(AccountId),
    to: Schema.NullOr(AccountId),
    amount: Schema.NullOr(Cents),
    debited: Schema.Boolean,
    credited: Schema.Boolean,
    refunded: Schema.Boolean,
    completedAt: Schema.NullOr(Schema.DateTimeUtc),
    failedReason: Schema.NullOr(Schema.String),
  }),
  initial: {
    from: null,
    to: null,
    amount: null,
    debited: false,
    credited: false,
    refunded: false,
    completedAt: null,
    failedReason: null,
  },
  evolve: {
    TransferRequested: (v, e) => ({ ...v, from: e.from, to: e.to, amount: e.amount }),
    TransferDebited: (v) => ({ ...v, debited: true }),
    TransferCredited: (v) => ({ ...v, credited: true }),
    TransferRefunded: (v) => ({ ...v, refunded: true }),
    TransferCompleted: (v, _, { at }) => ({ ...v, completedAt: at }),
    TransferFailed: (v, e) => ({ ...v, failedReason: e.reason }),
  },
  computed: {
    status: (v): "completed" | "failed" | "in-flight" | "pending" =>
      v.completedAt ? "completed" : v.failedReason ? "failed" : v.debited ? "in-flight" : "pending",
  },
}) {}
