import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetConstitution` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetConstitutionRequest extends Omit<
  data.GetConstitutionRequest,
  "ledgerEndpoint"
> {}

/**
 * Get the ledger's governance constitution (script and SHA-256 digest).
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetConstitutionHttp}.
 *
 * ### Calling GetConstitution
 * **Example:** GetConstitution from a Function
 * ```typescript
 * // init
 * const getConstitution = yield* Azure.ConfidentialLedger.GetConstitution(ledger);
 *
 * // runtime
 * const { digest } = yield* getConstitution();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetConstitution extends Binding.Service<
  GetConstitution,
  "Azure.ConfidentialLedger.GetConstitution",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: GetConstitutionRequest,
    ) => Effect.Effect<data.Constitution, data.GetConstitutionError, RuntimeContext>
  >
> {}

export const GetConstitution = Binding.Service<GetConstitution>(
  "Azure.ConfidentialLedger.GetConstitution",
);
