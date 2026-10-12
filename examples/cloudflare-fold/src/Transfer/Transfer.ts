import { Aggregate } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { Cents } from "../Money.ts";
import { CompleteTransfer, TransferCompleted } from "./CompleteTransfer.ts";
import { FailTransfer, TransferFailed } from "./FailTransfer.ts";
import {
  AlreadyRequested,
  RequestTransfer,
  SameAccount,
  TransferRequested,
} from "./RequestTransfer.ts";
import { TransferId } from "./TransferId.ts";

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
