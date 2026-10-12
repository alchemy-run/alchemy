import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { ExpireTransfer } from "./ExpireTransfer.ts";
import { TransferRequested } from "./RequestTransfer.ts";
import { Transfer } from "./Transfer.ts";

/** How long a support agent has to approve a large transfer. */
export const APPROVAL_WINDOW = "24 hours";

/**
 * Whenever a transfer needs approval, expire it if nobody approves it in time.
 * The Transfer decides the race: approval and expiry are commands on the same
 * instance, so exactly one of them wins.
 */
export class TransferApprovalDeadline extends Domain.Policy("TransferApprovalDeadline", {
  from: Transfer,
  on: [TransferRequested],
}) {}

export const TransferApprovalDeadlineLive = TransferApprovalDeadline.toLayer(
  Effect.gen(function* () {
    const transfers = yield* Transfer;
    return Effect.fn(function* ({ source, event }) {
      if (!event.needsApproval) return;
      yield* transfers.schedule(source, new ExpireTransfer(), { after: APPROVAL_WINDOW });
    });
  }),
);
