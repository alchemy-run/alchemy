import type * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";

/** `ListConsortiumMembers` request without the ledger endpoint, which the bound ledger supplies. */
export interface ListConsortiumMembersRequest extends Omit<
  data.ListConsortiumMembersRequest,
  "ledgerEndpoint" | "nextLink"
> {}

/**
 * List every member of the ledger's consortium, across pages.
 *
 * Binding gives the host the ledger role **Reader** (read entries and
 * receipts; the smallest ledger role) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts
 * the ledger's own certificate, so it must run on a Node.js runtime (an
 * Azure Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link ListConsortiumMembersHttp}.
 *
 * ### Calling ListConsortiumMembers
 * **Example:** ListConsortiumMembers from a Function
 * ```typescript
 * // init
 * const listConsortiumMembers = yield* Azure.ConfidentialLedger.ListConsortiumMembers(ledger);
 *
 * // runtime
 * const members = yield* listConsortiumMembers();
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface ListConsortiumMembers extends Binding.Service<
  ListConsortiumMembers,
  "Azure.ConfidentialLedger.ListConsortiumMembers",
  (
    ledger: Ledger,
  ) => Effect.Effect<
    (
      request?: ListConsortiumMembersRequest,
    ) => Effect.Effect<data.ConsortiumMember[], data.ListConsortiumMembersError, RuntimeContext>
  >
> {}

export const ListConsortiumMembers = Binding.Service<ListConsortiumMembers>(
  "Azure.ConfidentialLedger.ListConsortiumMembers",
);
