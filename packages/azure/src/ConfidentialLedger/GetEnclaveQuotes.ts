import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetEnclaveQuotes` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetEnclaveQuotesRequest extends Omit<
  data.GetEnclaveQuotesRequest,
  "ledgerEndpoint"
> {}

/**
 * Get the enclave quotes of the ledger's nodes, to verify the code they run.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetEnclaveQuotesHttp}.
 *
 * ### Calling GetEnclaveQuotes
 * **Example:** GetEnclaveQuotes from a Function
 * ```typescript
 * // init
 * const getEnclaveQuotes = yield* Azure.ConfidentialLedger.GetEnclaveQuotes(ledger);
 *
 * // runtime
 * const { currentNodeId, enclaveQuotes } = yield* getEnclaveQuotes();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetEnclaveQuotes extends Binding.Service<
  GetEnclaveQuotes,
  "Azure.ConfidentialLedger.GetEnclaveQuotes",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: GetEnclaveQuotesRequest,
    ) => Effect.Effect<data.ConfidentialLedgerEnclaves, data.GetEnclaveQuotesError, RuntimeContext>
  >
> {}

export const GetEnclaveQuotes = Binding.Service<GetEnclaveQuotes>(
  "Azure.ConfidentialLedger.GetEnclaveQuotes",
);
