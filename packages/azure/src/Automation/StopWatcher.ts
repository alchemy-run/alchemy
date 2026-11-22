import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Watcher } from "./Watcher.ts";

export interface StopWatcherRequest extends Omit<
  automation.StopWatcherRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName" | "watcherName"
> {}

/**
 * Stop a watcher task (`POST …/watchers/{watcherName}/stop`) from any host.
 *
 * Binding assigns a custom role (`AzureAutomationStopWatcherRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/watchers/stop/action`) on the watcher only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopWatcherHttp}.
 *
 * ### Calling StopWatcher
 * **Example:** StopWatcher from a Function
 * ```typescript
 * // init
 * const stopWatcher = yield* Azure.Automation.StopWatcher(watcher);
 *
 * // runtime
 * yield* stopWatcher();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopWatcher = yield* Azure.Automation.StopWatcher(watcher);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.StopWatcherHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface StopWatcher extends Binding.Service<
  StopWatcher,
  "Azure.Automation.StopWatcher",
  (
    watcher: Watcher,
  ) => Effect.Effect<
    (
      request?: StopWatcherRequest,
    ) => Effect.Effect<automation.StopWatcherResponse, automation.StopWatcherError, RuntimeContext>
  >
> {}

export const StopWatcher = Binding.Service<StopWatcher>("Azure.Automation.StopWatcher");
