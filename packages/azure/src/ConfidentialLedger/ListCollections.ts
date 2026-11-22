import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `ListCollections` request without the ledger endpoint, which the bound ledger supplies. */
export interface ListCollectionsRequest extends Omit<
  data.ListCollectionsRequest,
  "ledgerEndpoint" | "nextLink"
> {}

/**
 * List every collection of a ledger, across pages.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link ListCollectionsHttp}.
 *
 * ### Calling ListCollections
 * **Example:** ListCollections from a Function
 * ```typescript
 * // init
 * const listCollections = yield* Azure.ConfidentialLedger.ListCollections(ledger);
 *
 * // runtime
 * const collections = yield* listCollections();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface ListCollections extends Binding.Service<
  ListCollections,
  "Azure.ConfidentialLedger.ListCollections",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: ListCollectionsRequest,
    ) => Effect.Effect<data.Collection[], data.ListCollectionsError, RuntimeContext>
  >
> {}

export const ListCollections = Binding.Service<ListCollections>(
  "Azure.ConfidentialLedger.ListCollections",
);
