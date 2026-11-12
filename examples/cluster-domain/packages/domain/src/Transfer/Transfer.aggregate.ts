import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.context.ts";
import { CompleteTransfer, TransferCompleted } from "./CompleteTransfer.command.ts";
import { FailTransfer, TransferFailed } from "./FailTransfer.command.ts";
import {
  AlreadyRequested,
  RequestTransfer,
  SameAccount,
  TransferRequested,
} from "./RequestTransfer.command.ts";
import { TransferId } from "./Transfer.id.ts";

/** A transfer between two accounts: what `ExecuteTransfer` reports its outcome to. */
export class Transfer extends Domain.Aggregate("Transfer", {
  id: TransferId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Pending", {}),
    Schema.TaggedStruct("Completed", {}),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [RequestTransfer, CompleteTransfer, FailTransfer],
  decide: {
    // Records who asked, so ExecuteTransfer debits the source on their behalf.
    RequestTransfer: Effect.fn(function* (transfer, cmd, { id }) {
      if (transfer._tag !== "New") return yield* new AlreadyRequested();
      if (cmd.from === cmd.to) return yield* new SameAccount();
      const requestedBy = yield* CurrentActor;
      return [
        new TransferRequested({
          transferId: id,
          from: cmd.from,
          to: cmd.to,
          amount: cmd.amount,
          requestedBy,
        }),
      ];
    }),
    CompleteTransfer: (transfer, _, { id }) =>
      transfer._tag === "Pending" ? [new TransferCompleted({ transferId: id })] : [],
    FailTransfer: (transfer, cmd, { id }) =>
      transfer._tag === "Pending"
        ? [new TransferFailed({ transferId: id, reason: cmd.reason })]
        : [],
  },
  evolve: {
    TransferRequested: () => ({ _tag: "Pending" as const }),
    TransferCompleted: () => ({ _tag: "Completed" as const }),
    TransferFailed: (_, e) => ({ _tag: "Failed" as const, reason: e.reason }),
  },
}) {}
