import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Trigger } from "./Trigger.ts";

export interface RerunTriggerRunRequest extends Omit<
  datafactory.TriggerRunsRerunRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "triggerName"
> {}

/**
 * Rerun a run of a Data Factory tumbling window trigger by run ID (`POST
 * …/triggers/{trigger}/triggerRuns/{runId}/rerun`). Any other trigger type
 * fails with `TriggerRerunNotSupported`, an unknown run ID with
 * `TriggerRunNotFound`.
 *
 * Binding assigns a custom role (`AzureDataFactoryRerunTriggerRunRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/triggers/triggerruns/rerun/action`, on the
 * trigger only. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload identity)
 * the role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RerunTriggerRunHttp}.
 *
 * ### Calling RerunTriggerRun
 * **Example:** RerunTriggerRun from a Function
 * ```typescript
 * // init
 * const rerunTriggerRun = yield* Azure.DataFactory.RerunTriggerRun(trigger);
 *
 * // runtime
 * yield* rerunTriggerRun({ runId });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const rerunTriggerRun = yield* Azure.DataFactory.RerunTriggerRun(trigger);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.RerunTriggerRunHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface RerunTriggerRun extends Binding.Service<
  RerunTriggerRun,
  "Azure.DataFactory.RerunTriggerRun",
  (
    trigger: Trigger,
  ) => Effect.Effect<
    (
      request: RerunTriggerRunRequest,
    ) => Effect.Effect<
      datafactory.TriggerRunsRerunResponse,
      datafactory.TriggerRunsRerunError,
      RuntimeContext
    >
  >
> {}

export const RerunTriggerRun = Binding.Service<RerunTriggerRun>(
  "Azure.DataFactory.RerunTriggerRun",
);
