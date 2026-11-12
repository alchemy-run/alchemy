import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.aggregate.ts";
import { AccountId } from "../Account/Account.id.ts";
import { NotOwner } from "../Account/NotOwner.rejection.ts";
import { Actor } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Transfer } from "./Transfer.aggregate.ts";

/**
 * The progress of one transfer, assembled from the Transfer and both
 * accounts. Each handler sets its own fact, so arrival order does not matter.
 */
export class TransferStatus extends Domain.View("TransferStatus", {
  from: [Transfer, Account],
  key: Transfer,
  middleware: [Session],
  rejects: [NotOwner],
  keyOf: {
    TransferDebited: ({ event }) => Transfer.ref(event.transferId),
    TransferCredited: ({ event }) => Transfer.ref(event.transferId),
    TransferRefunded: ({ event }) => Transfer.ref(event.transferId),
  },
  state: Schema.Struct({
    from: Schema.NullOr(AccountId),
    to: Schema.NullOr(AccountId),
    amount: Schema.NullOr(Cents),
    requestedBy: Schema.NullOr(Actor),
    debited: Schema.Boolean,
    credited: Schema.Boolean,
    refunded: Schema.Boolean,
    completed: Schema.Boolean,
    failedReason: Schema.NullOr(Schema.String),
  }),
  initial: {
    from: null,
    to: null,
    amount: null,
    requestedBy: null,
    debited: false,
    credited: false,
    refunded: false,
    completed: false,
    failedReason: null,
  },
  evolve: {
    TransferRequested: (v, e) => ({
      ...v,
      from: e.from,
      to: e.to,
      amount: e.amount,
      requestedBy: e.requestedBy,
    }),
    TransferDebited: (v) => ({ ...v, debited: true }),
    TransferCredited: (v) => ({ ...v, credited: true }),
    TransferRefunded: (v) => ({ ...v, refunded: true }),
    TransferCompleted: (v) => ({ ...v, completed: true }),
    TransferFailed: (v, e) => ({ ...v, failedReason: e.reason }),
  },
  computed: {
    status: (v): "completed" | "failed" | "in-flight" | "pending" =>
      v.completed ? "completed" : v.failedReason ? "failed" : v.debited ? "in-flight" : "pending",
  },
}) {}

/** Only the transfer's requester may read it. */
export const TransferStatusLive = TransferStatus.toLayer(
  Effect.succeed(
    Effect.fn(function* (_request, status) {
      const actor = yield* CurrentActor;
      const requester = status?.requestedBy ?? null;
      if (requester === null || actor._tag === "System") return;
      if (requester._tag !== "Customer" || requester.customerId !== actor.customerId)
        return yield* new NotOwner();
    }),
  ),
);
