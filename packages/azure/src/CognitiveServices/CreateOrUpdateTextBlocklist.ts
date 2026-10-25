import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateOrUpdateTextBlocklistRequest extends Omit<
  contentSafety.TextBlocklistsCreateOrUpdateTextBlocklistRequest,
  "endpoint"
> {}

/**
 * Create a Content Safety text blocklist, or update its description.
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
 * Provide {@link CreateOrUpdateTextBlocklistHttp}.
 *
 * ### Calling CreateOrUpdateTextBlocklist
 * **Example:** CreateOrUpdateTextBlocklist from a Function
 * ```typescript
 * // init
 * const createBlocklist = yield* Azure.CognitiveServices.CreateOrUpdateTextBlocklist(safety);
 *
 * // runtime
 * yield* createBlocklist({ blocklistName: "banned", description: "Banned terms" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateOrUpdateTextBlocklist extends Binding.Service<
  CreateOrUpdateTextBlocklist,
  "Azure.CognitiveServices.CreateOrUpdateTextBlocklist",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateTextBlocklistRequest,
    ) => Effect.Effect<
      contentSafety.TextBlocklist,
      contentSafety.TextBlocklistsCreateOrUpdateTextBlocklistError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateTextBlocklist = Binding.Service<CreateOrUpdateTextBlocklist>(
  "Azure.CognitiveServices.CreateOrUpdateTextBlocklist",
);
