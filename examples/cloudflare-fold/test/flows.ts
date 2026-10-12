import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { type AccountId, mainAccountId } from "../src/Account/AccountId.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import type { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";
import { TransferId } from "../src/Transfer/TransferId.ts";

/** A CustomerApi client, signed in as one customer. */
export type CustomerClient = Effect.Success<typeof CustomerApi.client>;

/** The demo MFA code `MfaChallenge` accepts. */
export const mfa = { headers: { "x-mfa-code": "000000" } };

/**
 * Register, then wait until `MainAccountProvisioning` has opened the main
 * account: it appears on the customer's live dashboard.
 */
export const register = (client: CustomerClient, customerId: string, name: string) =>
  Effect.gen(function* () {
    const id = CustomerId.make(customerId);
    yield* client.RegisterCustomer({ target: id, name });
    const accountId = mainAccountId(id);
    yield* client.dashboard({}).pipe(
      Stream.filter((d) => d.accounts.some((a) => a.accountId === accountId)),
      Stream.runHead,
      Effect.timeout("20 seconds"),
    );
    return accountId;
  });

/**
 * Request a transfer under an id the client chooses (so a retry is
 * idempotent), then wait until `TransferExecution` has completed or failed it.
 */
export const transfer = (
  client: CustomerClient,
  transfer: {
    readonly transferId: string;
    readonly from: AccountId;
    readonly to: AccountId;
    readonly amount: number;
  },
) =>
  Effect.gen(function* () {
    const transferId = TransferId.make(transfer.transferId);
    yield* client.RequestTransfer(
      { target: transferId, from: transfer.from, to: transfer.to, amount: transfer.amount },
      mfa,
    );
    return yield* client.transferStatus({ transferId }).pipe(
      Effect.filterOrFail(
        (outcome) => outcome.status === "completed" || outcome.status === "failed",
        () => "still in flight",
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
    );
  });
