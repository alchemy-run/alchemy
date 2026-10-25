import type * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateTranscriptionRequest extends Omit<
  inference.CreateTranscriptionRequest,
  "endpoint" | "file"
> {
  /** The file to send: a `File` (its name is sent as the filename) or a `Blob`. */
  file: Blob;
}

/**
 * Transcribe audio with a speech model deployment (e.g. `whisper`) of an
 * Azure OpenAI account. Pass the audio as a `File` whose name carries its
 * format (`speech.wav`).
 *
 * Binding assigns a custom role (`AzureOpenAIAudioRole`, one per stack, shared with `OpenAICreateTranslation`)
 * with exactly the data action `OpenAI/deployments/audio/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateTranscriptionHttp}.
 *
 * ### Calling OpenAICreateTranscription
 * **Example:** OpenAICreateTranscription from a Function
 * ```typescript
 * // init
 * const transcribe = yield* Azure.CognitiveServices.OpenAICreateTranscription(account);
 *
 * // runtime
 * const text = yield* transcribe({
 *   deploymentId: "whisper",
 *   file: new File([audio], "speech.wav"),
 *   response_format: "json",
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateTranscription extends Binding.Service<
  OpenAICreateTranscription,
  "Azure.CognitiveServices.OpenAICreateTranscription",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateTranscriptionRequest,
    ) => Effect.Effect<
      inference.CreateTranscriptionResponse,
      inference.CreateTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateTranscription = Binding.Service<OpenAICreateTranscription>(
  "Azure.CognitiveServices.OpenAICreateTranscription",
);
