import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargePersonGroupTrainingStatusRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupTrainingStatusRequest,
  "endpoint"
> {}

/**
 * To check Large Person Group training status completed or still ongoing.
 * Large Person Group training is an asynchronous operation triggered by
 * "Train Large Person Group" API. Training time depends on the number of
 * person entries, and their faces in a Large Person Group.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupsTrainingReadRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/training/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargePersonGroupTrainingStatusHttp}.
 *
 * ### Calling GetLargePersonGroupTrainingStatus
 * **Example:** GetLargePersonGroupTrainingStatus from a Function
 * ```typescript
 * // init
 * const getLargePersonGroupTrainingStatus = yield* Azure.CognitiveServices.GetLargePersonGroupTrainingStatus(account);
 *
 * // runtime
 * const result = yield* getLargePersonGroupTrainingStatus({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargePersonGroupTrainingStatus extends Binding.Service<
  GetLargePersonGroupTrainingStatus,
  "Azure.CognitiveServices.GetLargePersonGroupTrainingStatus",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargePersonGroupTrainingStatusRequest,
    ) => Effect.Effect<
      face.TrainingResult,
      face.GetPersonGroupOperationLargePersonGroupTrainingStatusError,
      RuntimeContext
    >
  >
> {}

export const GetLargePersonGroupTrainingStatus = Binding.Service<GetLargePersonGroupTrainingStatus>(
  "Azure.CognitiveServices.GetLargePersonGroupTrainingStatus",
);
