import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CreateLedgerEntryRequest } from "./CreateLedgerEntry.ts";
import type { Ledger } from "./Ledger.ts";

/** Write client for one Confidential Ledger. */
export interface WriteLedgerClient {
  /** Append an entry; the result carries its `transactionId`. */
  createEntry(
    request: CreateLedgerEntryRequest,
  ): Effect.Effect<data.LedgerWriteResult, data.CreateLedgerEntryError, RuntimeContext>;
}

/**
 * Append entries to an Azure Confidential Ledger.
 *
 * Binding gives the host the ledger role **Contributor** (the smallest
 * ledger role that writes; it also reads) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts the
 * ledger's own certificate, so it must run on a Node.js runtime (an Azure
 * Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link LedgerWriteHttp}.
 *
 * ### Writing to a Ledger
 * **Example:** Record an audit event
 * ```typescript
 * // init
 * const audit = yield* Azure.ConfidentialLedger.LedgerWrite(ledger);
 *
 * // runtime
 * const { transactionId } = yield* audit.createEntry({
 *   contents: JSON.stringify({ user, action: "login" }),
 *   collectionId: "logins",
 * });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface LedgerWrite extends Binding.Service<
  LedgerWrite,
  "Azure.ConfidentialLedger.LedgerWrite",
  (ledger: Ledger) => Effect.Effect<WriteLedgerClient>
> {}

export const LedgerWrite = Binding.Service<LedgerWrite>("Azure.ConfidentialLedger.LedgerWrite");
