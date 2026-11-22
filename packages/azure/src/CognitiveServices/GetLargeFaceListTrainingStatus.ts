import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargeFaceListTrainingStatusRequest extends Omit<
  face.FaceListOperationsGetLargeFaceListTrainingStatusRequest,
  "endpoint"
> {}

/**
 * To check the Large Face List training status completed or still ongoing.
 * Large Face List training is an asynchronous operation triggered by "Train
 * Large Face List". Training time depends on the number of face entries in a
 * Large Face List. It could be in seconds, or up to half an hour for
 * 1,000,000 faces.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsTrainingReadRole`,
 * one per stack) with exactly the data action
 * `Face/largefacelists/training/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargeFaceListTrainingStatusHttp}.
 *
 * ### Calling GetLargeFaceListTrainingStatus
 * **Example:** GetLargeFaceListTrainingStatus from a Function
 * ```typescript
 * // init
 * const getLargeFaceListTrainingStatus = yield* Azure.CognitiveServices.GetLargeFaceListTrainingStatus(account);
 *
 * // runtime
 * const result = yield* getLargeFaceListTrainingStatus({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargeFaceListTrainingStatus extends Binding.Service<
  GetLargeFaceListTrainingStatus,
  "Azure.CognitiveServices.GetLargeFaceListTrainingStatus",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargeFaceListTrainingStatusRequest,
    ) => Effect.Effect<
      face.TrainingResult,
      face.FaceListOperationsGetLargeFaceListTrainingStatusError,
      RuntimeContext
    >
  >
> {}

export const GetLargeFaceListTrainingStatus = Binding.Service<GetLargeFaceListTrainingStatus>(
  "Azure.CognitiveServices.GetLargeFaceListTrainingStatus",
);
