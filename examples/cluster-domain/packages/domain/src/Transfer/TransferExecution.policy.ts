import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ExecuteTransfer } from "./ExecuteTransfer.saga.ts";
import { TransferRequested } from "./RequestTransfer.command.ts";
import { Transfer } from "./Transfer.aggregate.ts";

/** Starts the ExecuteTransfer saga for every requested transfer, keyed by the transfer. */
export class TransferExecution extends Domain.Policy("TransferExecution", {
  from: Transfer,
  on: [TransferRequested],
}) {}

export const TransferExecutionLive = TransferExecution.toLayer(
  Effect.gen(function* () {
    const executions = yield* ExecuteTransfer;
    return Effect.fn(function* ({ source, event }) {
      yield* executions.start(source, {
        from: event.from,
        to: event.to,
        amount: event.amount,
        requestedBy: event.requestedBy,
      });
    });
  }),
);
