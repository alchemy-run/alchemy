import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { AccountId } from "../Account/AccountId.ts";
import { customer } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { RequestTransfer, SameAccount, Transfer } from "../Transfer/Transfer.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { TransferStatus } from "../Transfer/TransferStatus.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { MfaChallenge } from "./MfaChallenge.ts";
import { TransferOutcome } from "./TransferOutcome.ts";

/** Start a transfer and wait (briefly) for its outcome. */
export class TransferFunds extends Mutation.make("transfer", {
  input: { from: AccountId, to: AccountId, amount: Cents },
  output: TransferOutcome,
  errors: [SameAccount],
})
  .middleware(CustomerSession)
  .middleware(MfaChallenge) {}

export const TransferFundsLive = TransferFunds.toLayer(
  Effect.gen(function* () {
    const transfers = yield* Transfer;
    const statuses = yield* TransferStatus;
    return Effect.fn(function* ({ from, to, amount }) {
      const { customerId } = yield* CurrentCustomer;
      const transferId = TransferId.make(crypto.randomUUID());
      yield* transfers
        .send(transferId, new RequestTransfer({ from, to, amount, by: customer(customerId) }))
        .pipe(
          Effect.catchTag("AlreadyRequested", () => Effect.die("a fresh transfer id collided")),
        );
      return yield* statuses
        .waitFor(
          Transfer.ref(transferId),
          { OR: [{ completedAt: { not: null } }, { failedReason: { not: null } }] },
          { timeout: "10 seconds" },
        )
        .pipe(
          Effect.map((v) => ({
            transferId,
            status: TransferStatus.computed.status(v),
            reason: v.failedReason,
          })),
          Effect.catchTag("WaitTimeout", () =>
            Effect.succeed({ transferId, status: "pending" as const, reason: null }),
          ),
        );
    });
  }),
);
