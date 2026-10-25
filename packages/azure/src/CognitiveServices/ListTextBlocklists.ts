import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListTextBlocklistsRequest extends Omit<
  contentSafety.ListTextBlocklistTextBlocklistsRequest,
  "endpoint"
> {}

/**
 * List the Content Safety text blocklists of the account, one page at a
 * time (pass the page's `nextLink` back for the next page).
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyReadBlocklistsRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text/blocklists/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListTextBlocklistsHttp}.
 *
 * ### Calling ListTextBlocklists
 * **Example:** ListTextBlocklists from a Function
 * ```typescript
 * // init
 * const listBlocklists = yield* Azure.CognitiveServices.ListTextBlocklists(safety);
 *
 * // runtime
 * const { value } = yield* listBlocklists();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListTextBlocklists extends Binding.Service<
  ListTextBlocklists,
  "Azure.CognitiveServices.ListTextBlocklists",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListTextBlocklistsRequest,
    ) => Effect.Effect<
      contentSafety.PagedTextBlocklist,
      contentSafety.ListTextBlocklistTextBlocklistsError,
      RuntimeContext
    >
  >
> {}

export const ListTextBlocklists = Binding.Service<ListTextBlocklists>(
  "Azure.CognitiveServices.ListTextBlocklists",
);
