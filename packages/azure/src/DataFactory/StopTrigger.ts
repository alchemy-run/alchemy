import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Trigger } from "./Trigger.ts";

export interface StopTriggerRequest extends Omit<
  datafactory.StopTriggerRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "triggerName"
> {}

/**
 * Stop a Data Factory trigger (`POST …/triggers/{trigger}/stop`). Alchemy
 * reconciles the trigger's `started` prop on the next deploy.
 *
 * Binding assigns a custom role (`AzureDataFactoryStopTriggerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/triggers/stop/action`, on the trigger only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link StopTriggerHttp}.
 *
 * ### Calling StopTrigger
 * **Example:** StopTrigger from a Function
 * ```typescript
 * // init
 * const stopTrigger = yield* Azure.DataFactory.StopTrigger(trigger);
 *
 * // runtime
 * yield* stopTrigger();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopTrigger = yield* Azure.DataFactory.StopTrigger(trigger);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.StopTriggerHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface StopTrigger extends Binding.Service<
  StopTrigger,
  "Azure.DataFactory.StopTrigger",
  (
    trigger: Trigger,
  ) => Effect.Effect<
    (
      request?: StopTriggerRequest,
    ) => Effect.Effect<
      datafactory.StopTriggerResponse,
      datafactory.StopTriggerError,
      RuntimeContext
    >
  >
> {}

export const StopTrigger = Binding.Service<StopTrigger>("Azure.DataFactory.StopTrigger");
