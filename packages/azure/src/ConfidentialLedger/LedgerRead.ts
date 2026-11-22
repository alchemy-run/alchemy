import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetCurrentLedgerEntryRequest } from "./GetCurrentLedgerEntry.ts";
import type { GetLedgerEntryRequest } from "./GetLedgerEntry.ts";
import type { GetReceiptRequest } from "./GetReceipt.ts";
import type { GetTransactionStatusRequest } from "./GetTransactionStatus.ts";
import type { Ledger } from "./Ledger.ts";
import type { ListCollectionsRequest } from "./ListCollections.ts";
import type { ListLedgerEntriesRequest } from "./ListLedgerEntries.ts";
import type { ListTagsRequest } from "./ListTags.ts";

/** Read client for one Confidential Ledger. */
export interface ReadLedgerClient {
  /** Read the entry written by one transaction (`state: "Loading"` until it is fetched). */
  getEntry(
    request: GetLedgerEntryRequest,
  ): Effect.Effect<data.LedgerQueryResult, data.GetLedgerEntryError, RuntimeContext>;
  /** Read the latest entry of a collection (the default collection when omitted). */
  getCurrentEntry(
    request?: GetCurrentLedgerEntryRequest,
  ): Effect.Effect<data.LedgerEntry, data.GetCurrentLedgerEntryError, RuntimeContext>;
  /** Read one page of entries (`state: "Loading"` until it is fetched; pass `nextLink` for the next page). */
  listEntries(
    request?: ListLedgerEntriesRequest,
  ): Effect.Effect<data.PagedLedgerEntries, data.ListLedgerEntriesError, RuntimeContext>;
  /** Get the signed receipt of a committed transaction. */
  getReceipt(
    request: GetReceiptRequest,
  ): Effect.Effect<data.TransactionReceipt, data.GetReceiptError, RuntimeContext>;
  /** Get whether a write is `Committed` or `Pending`. */
  getTransactionStatus(
    request: GetTransactionStatusRequest,
  ): Effect.Effect<data.TransactionStatus, data.GetTransactionStatusError, RuntimeContext>;
  /** List every collection, across pages. */
  listCollections(
    request?: ListCollectionsRequest,
  ): Effect.Effect<data.Collection[], data.ListCollectionsError, RuntimeContext>;
  /** List every tag of a collection, across pages. */
  listTags(request?: ListTagsRequest): Effect.Effect<string[], data.ListTagsError, RuntimeContext>;
}

/**
 * Read entries, receipts and transaction states of an Azure Confidential
 * Ledger.
 *
 * Binding gives the host the ledger role **Reader** (the smallest ledger
 * role) with an `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger
 * access is the ledger's own user list, not Azure RBAC; the deploying
 * identity must be a ledger `Administrator`. The host calls the ledger over
 * TLS that trusts the ledger's own certificate, so it must run on a Node.js
 * runtime (an Azure Function, App Service, Container App, …), not a
 * Cloudflare Worker. Provide {@link LedgerReadHttp}.
 *
 * ### Reading a Ledger
 * **Example:** Verify a write
 * ```typescript
 * // init
 * const audit = yield* Azure.ConfidentialLedger.LedgerRead(ledger);
 *
 * // runtime
 * const { state } = yield* audit.getTransactionStatus({ transactionId });
 * const receipt = yield* audit.getReceipt({ transactionId });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface LedgerRead extends Binding.Service<
  LedgerRead,
  "Azure.ConfidentialLedger.LedgerRead",
  (ledger: Ledger) => Effect.Effect<ReadLedgerClient>
> {}

export const LedgerRead = Binding.Service<LedgerRead>("Azure.ConfidentialLedger.LedgerRead");
