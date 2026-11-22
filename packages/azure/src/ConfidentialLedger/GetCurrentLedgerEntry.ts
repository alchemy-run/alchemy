import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `GetCurrentLedgerEntry` request without the ledger endpoint, which the bound ledger supplies. */
export interface GetCurrentLedgerEntryRequest extends Omit<
  data.GetCurrentLedgerEntryRequest,
  "ledgerEndpoint"
> {}

/**
 * Read the latest entry of a ledger collection (the default collection when
 * `collectionId` is omitted).
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link GetCurrentLedgerEntryHttp}.
 *
 * ### Calling GetCurrentLedgerEntry
 * **Example:** GetCurrentLedgerEntry from a Function
 * ```typescript
 * // init
 * const getCurrentLedgerEntry = yield* Azure.ConfidentialLedger.GetCurrentLedgerEntry(ledger);
 *
 * // runtime
 * const latest = yield* getCurrentLedgerEntry();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface GetCurrentLedgerEntry extends Binding.Service<
  GetCurrentLedgerEntry,
  "Azure.ConfidentialLedger.GetCurrentLedgerEntry",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: GetCurrentLedgerEntryRequest,
    ) => Effect.Effect<data.LedgerEntry, data.GetCurrentLedgerEntryError, RuntimeContext>
  >
> {}

export const GetCurrentLedgerEntry = Binding.Service<GetCurrentLedgerEntry>(
  "Azure.ConfidentialLedger.GetCurrentLedgerEntry",
);
