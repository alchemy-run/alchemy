import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TrainPersonGroupRequest extends Omit<
  face.PersonGroupOperationsTrainPersonGroupRequest,
  "endpoint"
> {}

/**
 * Submit a Person Group training task. Training is a crucial step that only
 * a trained Person Group can be used by "Identify From Person Group". The
 * training task is an asynchronous task. Training time depends on the number
 * of person entries, and their faces in a Person Group. It could be several
 * seconds to minutes.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupsTrainRole`, one per
 * stack) with exactly the data action `Face/persongroups/train/action`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link TrainPersonGroupHttp}.
 *
 * ### Calling TrainPersonGroup
 * **Example:** TrainPersonGroup from a Function
 * ```typescript
 * // init
 * const trainPersonGroup = yield* Azure.CognitiveServices.TrainPersonGroup(account);
 *
 * // runtime
 * const result = yield* trainPersonGroup({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TrainPersonGroup extends Binding.Service<
  TrainPersonGroup,
  "Azure.CognitiveServices.TrainPersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TrainPersonGroupRequest,
    ) => Effect.Effect<
      face.PersonGroupOperationsTrainPersonGroupResponse,
      face.PersonGroupOperationsTrainPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const TrainPersonGroup = Binding.Service<TrainPersonGroup>(
  "Azure.CognitiveServices.TrainPersonGroup",
);
