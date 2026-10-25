import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetReceipt` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetReceiptRequest extends Omit<data.GetReceiptRequest, "ledgerEndpoint"> {}

/**
 * Get the signed receipt that proves a committed transaction is in the
 * ledger. The ledger answers `state: "Loading"` while it builds the receipt;
 * call again until it is `Ready`.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetReceiptHttp}.
 *
 * ### Calling GetReceipt
 * **Example:** GetReceipt from a Function
 * ```typescript
 * // init
 * const getReceipt = yield* Azure.ConfidentialLedger.GetReceipt(ledger);
 *
 * // runtime
 * const receipt = yield* getReceipt({ transactionId });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetReceipt extends Binding.Service<
  GetReceipt,
  "Azure.ConfidentialLedger.GetReceipt",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request: GetReceiptRequest,
    ) => Effect.Effect<data.TransactionReceipt, data.GetReceiptError, RuntimeContext>
  >
> {}

export const GetReceipt = Binding.Service<GetReceipt>("Azure.ConfidentialLedger.GetReceipt");
