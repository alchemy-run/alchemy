import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `ListLedgerEntries` request without the ledger endpoint, which the bound ledger supplies. */
export interface ListLedgerEntriesRequest extends Omit<
  data.ListLedgerEntriesRequest,
  "ledgerEndpoint"
> {}

/**
 * Read one page of ledger entries in a transaction range, collection or tag.
 * The page is `state: "Loading"` while the ledger fetches older entries:
 * call again until it is `Ready`, then pass `nextLink` for the next page.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link ListLedgerEntriesHttp}.
 *
 * ### Calling ListLedgerEntries
 * **Example:** ListLedgerEntries from a Function
 * ```typescript
 * // init
 * const listLedgerEntries = yield* Azure.ConfidentialLedger.ListLedgerEntries(ledger);
 *
 * // runtime
 * const page = yield* listLedgerEntries({ collectionId: "audit" });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface ListLedgerEntries extends Binding.Service<
  ListLedgerEntries,
  "Azure.ConfidentialLedger.ListLedgerEntries",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: ListLedgerEntriesRequest,
    ) => Effect.Effect<data.PagedLedgerEntries, data.ListLedgerEntriesError, RuntimeContext>
  >
> {}

export const ListLedgerEntries = Binding.Service<ListLedgerEntries>(
  "Azure.ConfidentialLedger.ListLedgerEntries",
);
