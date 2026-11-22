import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetTransactionStatus` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetTransactionStatusRequest extends Omit<
  data.GetTransactionStatusRequest,
  "ledgerEndpoint"
> {}

/**
 * Get whether a ledger write is `Committed` (durable) or still `Pending`.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetTransactionStatusHttp}.
 *
 * ### Calling GetTransactionStatus
 * **Example:** GetTransactionStatus from a Function
 * ```typescript
 * // init
 * const getTransactionStatus = yield* Azure.ConfidentialLedger.GetTransactionStatus(ledger);
 *
 * // runtime
 * const { state } = yield* getTransactionStatus({ transactionId });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetTransactionStatus extends Binding.Service<
  GetTransactionStatus,
  "Azure.ConfidentialLedger.GetTransactionStatus",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request: GetTransactionStatusRequest,
    ) => Effect.Effect<data.TransactionStatus, data.GetTransactionStatusError, RuntimeContext>
  >
> {}

export const GetTransactionStatus = Binding.Service<GetTransactionStatus>(
  "Azure.ConfidentialLedger.GetTransactionStatus",
);
