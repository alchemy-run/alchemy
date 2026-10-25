import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddOrUpdateTextBlocklistItemsRequest extends Omit<
  contentSafety.TextBlocklistsAddOrUpdateBlocklistItemsRequest,
  "endpoint"
> {}

/**
 * Add items (terms or regular expressions) to a Content Safety text
 * blocklist, or update existing ones.
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
 * Provide {@link AddOrUpdateTextBlocklistItemsHttp}.
 *
 * ### Calling AddOrUpdateTextBlocklistItems
 * **Example:** AddOrUpdateTextBlocklistItems from a Function
 * ```typescript
 * // init
 * const addItems = yield* Azure.CognitiveServices.AddOrUpdateTextBlocklistItems(safety);
 *
 * // runtime
 * const { blocklistItems } = yield* addItems({
 *   blocklistName: "banned",
 *   blocklistItems: [{ text: "forbidden" }, { text: "bad\\w+", isRegex: true }],
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddOrUpdateTextBlocklistItems extends Binding.Service<
  AddOrUpdateTextBlocklistItems,
  "Azure.CognitiveServices.AddOrUpdateTextBlocklistItems",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddOrUpdateTextBlocklistItemsRequest,
    ) => Effect.Effect<
      contentSafety.AddOrUpdateTextBlocklistItemsResult,
      contentSafety.TextBlocklistsAddOrUpdateBlocklistItemsError,
      RuntimeContext
    >
  >
> {}

export const AddOrUpdateTextBlocklistItems = Binding.Service<AddOrUpdateTextBlocklistItems>(
  "Azure.CognitiveServices.AddOrUpdateTextBlocklistItems",
);
