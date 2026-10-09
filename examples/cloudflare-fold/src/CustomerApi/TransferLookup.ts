import { Query } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NotOwner } from "../Account/Account.ts";
import { Transfer } from "../Transfer/Transfer.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { TransferStatus } from "../Transfer/TransferStatus.ts";
import { CustomerSession } from "./CustomerSession.ts";
import { makeOwnedAccount } from "./ownedAccount.ts";
import { TransferOutcome } from "./TransferOutcome.ts";

/** Where a transfer stands. Either side of the transfer may look. */
export class TransferLookup extends Query.make("transferStatus", {
  input: { transferId: TransferId },
  output: TransferOutcome,
  errors: [NotOwner],
}).middleware(CustomerSession) {}

export const TransferLookupLive = TransferLookup.toLayer(
  Effect.gen(function* () {
    const statuses = yield* TransferStatus;
    const ownedAccount = yield* makeOwnedAccount;
    return Effect.fn(function* ({ transferId }) {
      const found = yield* statuses.query(Transfer.ref(transferId)).pipe(Effect.orDie);
      // Don't reveal whether someone else's transfer exists.
      if (Option.isNone(found)) return yield* new NotOwner();
      const { from, to } = found.value;
      if (!from || !to) return yield* new NotOwner();
      yield* ownedAccount(from).pipe(Effect.catchTag("NotOwner", () => ownedAccount(to)));
      return {
        transferId,
        status: TransferStatus.computed.status(found.value),
        reason: found.value.failedReason,
      };
    });
  }),
);
