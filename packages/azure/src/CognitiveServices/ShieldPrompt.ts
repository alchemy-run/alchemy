import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ShieldPromptRequest extends Omit<
  contentSafety.TextOperationsShieldPromptRequest,
  "endpoint"
> {}

/**
 * Detect prompt-injection attacks in a user prompt and in documents fed
 * to a model (Prompt Shields, Azure AI Content Safety).
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyShieldPromptRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text:shieldprompt/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ShieldPromptHttp}.
 *
 * ### Calling ShieldPrompt
 * **Example:** ShieldPrompt from a Function
 * ```typescript
 * // init
 * const shieldPrompt = yield* Azure.CognitiveServices.ShieldPrompt(safety);
 *
 * // runtime
 * const result = yield* shieldPrompt({ userPrompt: input, documents: [retrieved] });
 * // result.userPromptAnalysis?.attackDetected → boolean
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ShieldPrompt extends Binding.Service<
  ShieldPrompt,
  "Azure.CognitiveServices.ShieldPrompt",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ShieldPromptRequest,
    ) => Effect.Effect<
      contentSafety.ShieldPromptResult,
      contentSafety.TextOperationsShieldPromptError,
      RuntimeContext
    >
  >
> {}

export const ShieldPrompt = Binding.Service<ShieldPrompt>("Azure.CognitiveServices.ShieldPrompt");
