import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetTextBlocklistItemRequest extends Omit<
  contentSafety.GetTextBlocklistTextBlocklistItemRequest,
  "endpoint"
> {}

/**
 * Read one item of a Content Safety text blocklist.
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
 * Provide {@link GetTextBlocklistItemHttp}.
 *
 * ### Calling GetTextBlocklistItem
 * **Example:** GetTextBlocklistItem from a Function
 * ```typescript
 * // init
 * const getItem = yield* Azure.CognitiveServices.GetTextBlocklistItem(safety);
 *
 * // runtime
 * const item = yield* getItem({ blocklistName: "banned", blocklistItemId: itemId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetTextBlocklistItem extends Binding.Service<
  GetTextBlocklistItem,
  "Azure.CognitiveServices.GetTextBlocklistItem",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetTextBlocklistItemRequest,
    ) => Effect.Effect<
      contentSafety.TextBlocklistItem,
      contentSafety.GetTextBlocklistTextBlocklistItemError,
      RuntimeContext
    >
  >
> {}

export const GetTextBlocklistItem = Binding.Service<GetTextBlocklistItem>(
  "Azure.CognitiveServices.GetTextBlocklistItem",
);
