import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `ListTags` request without the ledger endpoint, which the bound ledger supplies. */
export interface ListTagsRequest extends Omit<
  data.ListTagsRequest,
  "ledgerEndpoint" | "nextLink"
> {}

/**
 * List every tag used by the entries of a ledger collection, across pages.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link ListTagsHttp}.
 *
 * ### Calling ListTags
 * **Example:** ListTags from a Function
 * ```typescript
 * // init
 * const listTags = yield* Azure.ConfidentialLedger.ListTags(ledger);
 *
 * // runtime
 * const tags = yield* listTags({ collectionId: "audit" });
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface ListTags extends Binding.Service<
  ListTags,
  "Azure.ConfidentialLedger.ListTags",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (request?: ListTagsRequest) => Effect.Effect<string[], data.ListTagsError, RuntimeContext>
  >
> {}

export const ListTags = Binding.Service<ListTags>("Azure.ConfidentialLedger.ListTags");
