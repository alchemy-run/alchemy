import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListTextBlocklistItemsRequest extends Omit<
  contentSafety.ListTextBlocklistTextBlocklistItemsRequest,
  "endpoint"
> {}

/**
 * List the items of a Content Safety text blocklist, one page at a time
 * (pass the page's `nextLink` back for the next page).
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyReadBlocklistItemsRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text/blocklists/blockitems/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListTextBlocklistItemsHttp}.
 *
 * ### Calling ListTextBlocklistItems
 * **Example:** ListTextBlocklistItems from a Function
 * ```typescript
 * // init
 * const listItems = yield* Azure.CognitiveServices.ListTextBlocklistItems(safety);
 *
 * // runtime
 * const { value } = yield* listItems({ blocklistName: "banned" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListTextBlocklistItems extends Binding.Service<
  ListTextBlocklistItems,
  "Azure.CognitiveServices.ListTextBlocklistItems",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListTextBlocklistItemsRequest,
    ) => Effect.Effect<
      contentSafety.PagedTextBlocklistItem,
      contentSafety.ListTextBlocklistTextBlocklistItemsError,
      RuntimeContext
    >
  >
> {}

export const ListTextBlocklistItems = Binding.Service<ListTextBlocklistItems>(
  "Azure.CognitiveServices.ListTextBlocklistItems",
);
