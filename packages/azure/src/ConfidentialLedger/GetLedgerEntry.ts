import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetLedgerEntry` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetLedgerEntryRequest extends Omit<data.GetLedgerEntryRequest, "ledgerEndpoint"> {}

/**
 * Read the ledger entry written by one transaction. The ledger answers
 * `state: "Loading"` while it fetches an older entry; call again until it is
 * `Ready`.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetLedgerEntryHttp}.
 *
 * ### Calling GetLedgerEntry
 * **Example:** GetLedgerEntry from a Function
 * ```typescript
 * // init
 * const getLedgerEntry = yield* Azure.ConfidentialLedger.GetLedgerEntry(ledger);
 *
 * // runtime
 * const { state, entry } = yield* getLedgerEntry({ transactionId });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetLedgerEntry extends Binding.Service<
  GetLedgerEntry,
  "Azure.ConfidentialLedger.GetLedgerEntry",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request: GetLedgerEntryRequest,
    ) => Effect.Effect<data.LedgerQueryResult, data.GetLedgerEntryError, RuntimeContext>
  >
> {}

export const GetLedgerEntry = Binding.Service<GetLedgerEntry>(
  "Azure.ConfidentialLedger.GetLedgerEntry",
);
