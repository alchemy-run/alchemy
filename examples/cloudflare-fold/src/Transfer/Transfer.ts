import { Aggregate, Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { TransferId } from "./TransferId.ts";

// ── Rejections ──────────────────────────────────────────────────

export class AlreadyRequested extends Rejection.make("AlreadyRequested") {}

export class SameAccount extends Rejection.make("SameAccount") {}

// ── Events ──────────────────────────────────────────────────────

export class TransferRequested extends Event.make("TransferRequested", {
  data: {
    transferId: TransferId,
    from: AccountId,
    to: AccountId,
    amount: Cents,
    requestedBy: Actor,
  },
}) {}

export class TransferCompleted extends Event.make("TransferCompleted", {
  data: { transferId: TransferId },
}) {}

export class TransferFailed extends Event.make("TransferFailed", {
  data: { transferId: TransferId, reason: Schema.String },
}) {}

// ── Commands ────────────────────────────────────────────────────

export class RequestTransfer extends Command.make("RequestTransfer", {
  input: { from: AccountId, to: AccountId, amount: Cents, by: Actor },
  rejects: [AlreadyRequested, SameAccount],
}) {}

/** Reports an outcome, so it never rejects. */
export class CompleteTransfer extends Command.make("CompleteTransfer") {}

/** Reports an outcome, so it never rejects. */
export class FailTransfer extends Command.make("FailTransfer", {
  input: { reason: Schema.String },
}) {}

/** A transfer between two accounts: the state of the TransferExecution process. */
export class Transfer extends Aggregate.make("Transfer", {
  id: TransferId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Pending", { from: AccountId, to: AccountId, amount: Cents }),
    Schema.TaggedStruct("Completed", {}),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [RequestTransfer, CompleteTransfer, FailTransfer],
  events: [TransferRequested, TransferCompleted, TransferFailed],
  decide: {
    RequestTransfer: (s, cmd, { id }) =>
      s._tag !== "New"
        ? new AlreadyRequested()
        : cmd.from === cmd.to
          ? new SameAccount()
          : [
              new TransferRequested({
                transferId: id,
                from: cmd.from,
                to: cmd.to,
                amount: cmd.amount,
                requestedBy: cmd.by,
              }),
            ],
    CompleteTransfer: (s, _, { id }) =>
      s._tag === "Pending" ? [new TransferCompleted({ transferId: id })] : [],
    FailTransfer: (s, cmd, { id }) =>
      s._tag === "Pending" ? [new TransferFailed({ transferId: id, reason: cmd.reason })] : [],
  },
  evolve: {
    TransferRequested: (_, e) => ({
      _tag: "Pending" as const,
      from: e.from,
      to: e.to,
      amount: e.amount,
    }),
    TransferCompleted: () => ({ _tag: "Completed" as const }),
    TransferFailed: (_, e) => ({ _tag: "Failed" as const, reason: e.reason }),
  },
}) {}
