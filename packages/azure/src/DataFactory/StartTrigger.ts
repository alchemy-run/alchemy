import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Trigger } from "./Trigger.ts";

export interface StartTriggerRequest extends Omit<
  datafactory.StartTriggerRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "triggerName"
> {}

/**
 * Start a Data Factory trigger (`POST …/triggers/{trigger}/start`). Alchemy
 * reconciles the trigger's `started` prop on the next deploy.
 *
 * Binding assigns a custom role (`AzureDataFactoryStartTriggerRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/triggers/start/action`, on the trigger
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartTriggerHttp}.
 *
 * ### Calling StartTrigger
 * **Example:** StartTrigger from a Function
 * ```typescript
 * // init
 * const startTrigger = yield* Azure.DataFactory.StartTrigger(trigger);
 *
 * // runtime
 * yield* startTrigger();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startTrigger = yield* Azure.DataFactory.StartTrigger(trigger);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.StartTriggerHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface StartTrigger extends Binding.Service<
  StartTrigger,
  "Azure.DataFactory.StartTrigger",
  (
    trigger: Trigger,
  ) => Effect.Effect<
    (
      request?: StartTriggerRequest,
    ) => Effect.Effect<
      datafactory.StartTriggerResponse,
      datafactory.StartTriggerError,
      RuntimeContext
    >
  >
> {}

export const StartTrigger = Binding.Service<StartTrigger>("Azure.DataFactory.StartTrigger");
