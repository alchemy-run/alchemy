import type * as identity from "@distilled.cloud/azure/confidentialledger-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/**
 * Get a Confidential Ledger's network identity: the PEM certificate its
 * nodes serve TLS with. Clients pin it to verify they talk to the ledger.
 *
 * The identity service (`identity.confidential-ledger.core.azure.com`) is
 * anonymous, so the binding grants no role. Provide
 * {@link GetLedgerIdentityHttp}.
 *
 * ### Calling GetLedgerIdentity
 * **Example:** Read the ledger's TLS certificate
 * ```typescript
 * // init
 * const getLedgerIdentity = yield* Azure.ConfidentialLedger.GetLedgerIdentity(ledger);
 *
 * // runtime
 * const { ledgerTlsCertificate } = yield* getLedgerIdentity();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetLedgerIdentity extends Binding.Service<
  GetLedgerIdentity,
  "Azure.ConfidentialLedger.GetLedgerIdentity",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    () => Effect.Effect<
      identity.LedgerIdentityInformation,
      identity.GetLedgerIdentityError,
      RuntimeContext
    >
  >
> {}

export const GetLedgerIdentity = Binding.Service<GetLedgerIdentity>(
  "Azure.ConfidentialLedger.GetLedgerIdentity",
);
