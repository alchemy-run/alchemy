import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteTextBlocklistRequest extends Omit<
  contentSafety.DeleteTextBlocklistTextBlocklistRequest,
  "endpoint"
> {}

/**
 * Delete a Content Safety text blocklist and its items.
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyDeleteBlocklistsRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text/blocklists/delete`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteTextBlocklistHttp}.
 *
 * ### Calling DeleteTextBlocklist
 * **Example:** DeleteTextBlocklist from a Function
 * ```typescript
 * // init
 * const deleteBlocklist = yield* Azure.CognitiveServices.DeleteTextBlocklist(safety);
 *
 * // runtime
 * yield* deleteBlocklist({ blocklistName: "banned" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteTextBlocklist extends Binding.Service<
  DeleteTextBlocklist,
  "Azure.CognitiveServices.DeleteTextBlocklist",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteTextBlocklistRequest,
    ) => Effect.Effect<
      contentSafety.DeleteTextBlocklistTextBlocklistResponse,
      contentSafety.DeleteTextBlocklistTextBlocklistError,
      RuntimeContext
    >
  >
> {}

export const DeleteTextBlocklist = Binding.Service<DeleteTextBlocklist>(
  "Azure.CognitiveServices.DeleteTextBlocklist",
);
