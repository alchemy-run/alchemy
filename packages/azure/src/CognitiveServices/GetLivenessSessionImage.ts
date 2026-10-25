import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLivenessSessionImageRequest extends Omit<
  face.GetLivenessSessionOperationSessionImageRequest,
  "endpoint"
> {}

/**
 * Get session image stored during the liveness session.
 *
 * Binding assigns a custom role (`AzureAISessionImagesReadRole`, one per
 * stack) with exactly the data action `Face/session/sessionimages/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLivenessSessionImageHttp}.
 *
 * ### Calling GetLivenessSessionImage
 * **Example:** GetLivenessSessionImage from a Function
 * ```typescript
 * // init
 * const getLivenessSessionImage = yield* Azure.CognitiveServices.GetLivenessSessionImage(account);
 *
 * // runtime
 * const result = yield* getLivenessSessionImage({ sessionImageId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLivenessSessionImage extends Binding.Service<
  GetLivenessSessionImage,
  "Azure.CognitiveServices.GetLivenessSessionImage",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLivenessSessionImageRequest,
    ) => Effect.Effect<
      face.GetLivenessSessionOperationSessionImageResponse,
      face.GetLivenessSessionOperationSessionImageError,
      RuntimeContext
    >
  >
> {}

export const GetLivenessSessionImage = Binding.Service<GetLivenessSessionImage>(
  "Azure.CognitiveServices.GetLivenessSessionImage",
);
