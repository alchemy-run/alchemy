import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TrainLargeFaceListRequest extends Omit<
  face.FaceListOperationsTrainLargeFaceListRequest,
  "endpoint"
> {}

/**
 * Submit a Large Face List training task. Training is a crucial step that
 * only a trained Large Face List can be used by "Find Similar From Large
 * Face List". The training task is an asynchronous task. Training time
 * depends on the number of face entries in a Large Face List.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsTrainRole`, one per
 * stack) with exactly the data action `Face/largefacelists/train/action`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link TrainLargeFaceListHttp}.
 *
 * ### Calling TrainLargeFaceList
 * **Example:** TrainLargeFaceList from a Function
 * ```typescript
 * // init
 * const trainLargeFaceList = yield* Azure.CognitiveServices.TrainLargeFaceList(account);
 *
 * // runtime
 * const result = yield* trainLargeFaceList({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TrainLargeFaceList extends Binding.Service<
  TrainLargeFaceList,
  "Azure.CognitiveServices.TrainLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TrainLargeFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsTrainLargeFaceListResponse,
      face.FaceListOperationsTrainLargeFaceListError,
      RuntimeContext
    >
  >
> {}

export const TrainLargeFaceList = Binding.Service<TrainLargeFaceList>(
  "Azure.CognitiveServices.TrainLargeFaceList",
);
