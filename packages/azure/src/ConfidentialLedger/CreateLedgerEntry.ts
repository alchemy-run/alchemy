import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `CreateLedgerEntry` request without the ledger endpoint, which the bound ledger supplies. */
export interface CreateLedgerEntryRequest extends Omit<
  data.CreateLedgerEntryRequest,
  "ledgerEndpoint"
> {}

/**
 * Append an entry to an Azure Confidential Ledger (optionally to a
 * collection) and get its transaction ID.
 *
 * Binding gives the host the ledger role **Contributor** (read and write
 * entries; the smallest ledger role that writes) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link CreateLedgerEntryHttp}.
 *
 * ### Calling CreateLedgerEntry
 * **Example:** CreateLedgerEntry from a Function
 * ```typescript
 * // init
 * const createLedgerEntry = yield* Azure.ConfidentialLedger.CreateLedgerEntry(ledger);
 *
 * // runtime
 * const { transactionId } = yield* createLedgerEntry({ contents: JSON.stringify(event) });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface CreateLedgerEntry extends Binding.Service<
  CreateLedgerEntry,
  "Azure.ConfidentialLedger.CreateLedgerEntry",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request: CreateLedgerEntryRequest,
    ) => Effect.Effect<data.LedgerWriteResult, data.CreateLedgerEntryError, RuntimeContext>
  >
> {}

export const CreateLedgerEntry = Binding.Service<CreateLedgerEntry>(
  "Azure.ConfidentialLedger.CreateLedgerEntry",
);
