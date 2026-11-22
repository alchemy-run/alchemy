import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TrainLargePersonGroupRequest extends Omit<
  face.PersonGroupOperationsTrainLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Submit a Large Person Group training task. Training is a crucial step that
 * only a trained Large Person Group can be used by "Identify From Large
 * Person Group". The training task is an asynchronous task. Training time
 * depends on the number of person entries, and their faces in a Large Person
 * Group.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupsTrainRole`, one
 * per stack) with exactly the data action
 * `Face/largepersongroups/train/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link TrainLargePersonGroupHttp}.
 *
 * ### Calling TrainLargePersonGroup
 * **Example:** TrainLargePersonGroup from a Function
 * ```typescript
 * // init
 * const trainLargePersonGroup = yield* Azure.CognitiveServices.TrainLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* trainLargePersonGroup({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TrainLargePersonGroup extends Binding.Service<
  TrainLargePersonGroup,
  "Azure.CognitiveServices.TrainLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TrainLargePersonGroupRequest,
    ) => Effect.Effect<
      face.PersonGroupOperationsTrainLargePersonGroupResponse,
      face.PersonGroupOperationsTrainLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const TrainLargePersonGroup = Binding.Service<TrainLargePersonGroup>(
  "Azure.CognitiveServices.TrainLargePersonGroup",
);
