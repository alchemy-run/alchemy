import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetPersonGroupTrainingStatusRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupTrainingStatusRequest,
  "endpoint"
> {}

/**
 * To check Person Group training status completed or still ongoing. Person
 * Group training is an asynchronous operation triggered by "Train Person
 * Group" API.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupsTrainingReadRole`, one
 * per stack) with exactly the data action `Face/persongroups/training/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetPersonGroupTrainingStatusHttp}.
 *
 * ### Calling GetPersonGroupTrainingStatus
 * **Example:** GetPersonGroupTrainingStatus from a Function
 * ```typescript
 * // init
 * const getPersonGroupTrainingStatus = yield* Azure.CognitiveServices.GetPersonGroupTrainingStatus(account);
 *
 * // runtime
 * const result = yield* getPersonGroupTrainingStatus({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetPersonGroupTrainingStatus extends Binding.Service<
  GetPersonGroupTrainingStatus,
  "Azure.CognitiveServices.GetPersonGroupTrainingStatus",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetPersonGroupTrainingStatusRequest,
    ) => Effect.Effect<
      face.TrainingResult,
      face.GetPersonGroupOperationPersonGroupTrainingStatusError,
      RuntimeContext
    >
  >
> {}

export const GetPersonGroupTrainingStatus = Binding.Service<GetPersonGroupTrainingStatus>(
  "Azure.CognitiveServices.GetPersonGroupTrainingStatus",
);
