import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface RemoveTextBlocklistItemsRequest extends Omit<
  contentSafety.RemoveTextBlocklistBlocklistItemsRequest,
  "endpoint"
> {}

/**
 * Remove items from a Content Safety text blocklist by item ID.
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyWriteBlocklistsRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text/blocklists/write`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RemoveTextBlocklistItemsHttp}.
 *
 * ### Calling RemoveTextBlocklistItems
 * **Example:** RemoveTextBlocklistItems from a Function
 * ```typescript
 * // init
 * const removeItems = yield* Azure.CognitiveServices.RemoveTextBlocklistItems(safety);
 *
 * // runtime
 * yield* removeItems({ blocklistName: "banned", blocklistItemIds: [itemId] });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface RemoveTextBlocklistItems extends Binding.Service<
  RemoveTextBlocklistItems,
  "Azure.CognitiveServices.RemoveTextBlocklistItems",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: RemoveTextBlocklistItemsRequest,
    ) => Effect.Effect<
      contentSafety.RemoveTextBlocklistBlocklistItemsResponse,
      contentSafety.RemoveTextBlocklistBlocklistItemsError,
      RuntimeContext
    >
  >
> {}

export const RemoveTextBlocklistItems = Binding.Service<RemoveTextBlocklistItems>(
  "Azure.CognitiveServices.RemoveTextBlocklistItems",
);
