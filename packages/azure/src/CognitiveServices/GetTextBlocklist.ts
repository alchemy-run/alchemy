import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetTextBlocklistRequest extends Omit<
  contentSafety.GetTextBlocklistTextBlocklistRequest,
  "endpoint"
> {}

/**
 * Read a Content Safety text blocklist.
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
 * Provide {@link GetTextBlocklistHttp}.
 *
 * ### Calling GetTextBlocklist
 * **Example:** GetTextBlocklist from a Function
 * ```typescript
 * // init
 * const getBlocklist = yield* Azure.CognitiveServices.GetTextBlocklist(safety);
 *
 * // runtime
 * const blocklist = yield* getBlocklist({ blocklistName: "banned" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetTextBlocklist extends Binding.Service<
  GetTextBlocklist,
  "Azure.CognitiveServices.GetTextBlocklist",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetTextBlocklistRequest,
    ) => Effect.Effect<
      contentSafety.TextBlocklist,
      contentSafety.GetTextBlocklistTextBlocklistError,
      RuntimeContext
    >
  >
> {}

export const GetTextBlocklist = Binding.Service<GetTextBlocklist>(
  "Azure.CognitiveServices.GetTextBlocklist",
);
