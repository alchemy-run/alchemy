import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateLargePersonGroupPersonFaceRequest extends Omit<
  face.UpdatePersonGroupOperationLargePersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Update a person persisted face's userData field.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupFacesWriteRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/persistedfaces/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateLargePersonGroupPersonFaceHttp}.
 *
 * ### Calling UpdateLargePersonGroupPersonFace
 * **Example:** UpdateLargePersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const updateLargePersonGroupPersonFace = yield* Azure.CognitiveServices.UpdateLargePersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* updateLargePersonGroupPersonFace({ largePersonGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateLargePersonGroupPersonFace extends Binding.Service<
  UpdateLargePersonGroupPersonFace,
  "Azure.CognitiveServices.UpdateLargePersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateLargePersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationLargePersonGroupPersonFaceResponse,
      face.UpdatePersonGroupOperationLargePersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const UpdateLargePersonGroupPersonFace = Binding.Service<UpdateLargePersonGroupPersonFace>(
  "Azure.CognitiveServices.UpdateLargePersonGroupPersonFace",
);
