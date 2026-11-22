import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Trigger } from "./Trigger.ts";

export interface CancelTriggerRunRequest extends Omit<
  datafactory.CancelTriggerRunRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "triggerName"
> {}

/**
 * Cancel a run of a Data Factory trigger by run ID (`POST
 * …/triggers/{trigger}/triggerRuns/{runId}/cancel`). An unknown run ID fails
 * with `TriggerRunNotFound`.
 *
 * Binding assigns a custom role (`AzureDataFactoryCancelTriggerRunRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/triggers/triggerruns/cancel/action`, on the
 * trigger only. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload identity)
 * the role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelTriggerRunHttp}.
 *
 * ### Calling CancelTriggerRun
 * **Example:** CancelTriggerRun from a Function
 * ```typescript
 * // init
 * const cancelTriggerRun = yield* Azure.DataFactory.CancelTriggerRun(trigger);
 *
 * // runtime
 * yield* cancelTriggerRun({ runId });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const cancelTriggerRun = yield* Azure.DataFactory.CancelTriggerRun(trigger);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.CancelTriggerRunHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface CancelTriggerRun extends Binding.Service<
  CancelTriggerRun,
  "Azure.DataFactory.CancelTriggerRun",
  (
    trigger: Trigger,
  ) => Effect.Effect<
    (
      request: CancelTriggerRunRequest,
    ) => Effect.Effect<
      datafactory.CancelTriggerRunResponse,
      datafactory.CancelTriggerRunError,
      RuntimeContext
    >
  >
> {}

export const CancelTriggerRun = Binding.Service<CancelTriggerRun>(
  "Azure.DataFactory.CancelTriggerRun",
);
