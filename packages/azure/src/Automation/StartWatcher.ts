import type * as automation from "@distilled.cloud/azure/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Watcher } from "./Watcher.ts";

export interface StartWatcherRequest extends Omit<
  automation.StartWatcherRequest,
  "subscriptionId" | "resourceGroupName" | "automationAccountName" | "watcherName"
> {}

/**
 * Start a watcher task (`POST …/watchers/{watcherName}/start`) so it runs its script on its hybrid worker group again, from any host.
 *
 * Binding assigns a custom role (`AzureAutomationStartWatcherRole`, one per stack, with
 * exactly the action `Microsoft.Automation/automationAccounts/watchers/start/action`) on the watcher only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartWatcherHttp}.
 *
 * ### Calling StartWatcher
 * **Example:** StartWatcher from a Function
 * ```typescript
 * // init
 * const startWatcher = yield* Azure.Automation.StartWatcher(watcher);
 *
 * // runtime
 * yield* startWatcher();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startWatcher = yield* Azure.Automation.StartWatcher(watcher);
 *   // ...
 * }).pipe(Effect.provide(Azure.Automation.StartWatcherHttp));
 * ```
 *
 * @binding
 * @category Automation
 */
export interface StartWatcher extends Binding.Service<
  StartWatcher,
  "Azure.Automation.StartWatcher",
  (
    watcher: Watcher,
  ) => Effect.Effect<
    (
      request?: StartWatcherRequest,
    ) => Effect.Effect<
      automation.StartWatcherResponse,
      automation.StartWatcherError,
      RuntimeContext
    >
  >
> {}

export const StartWatcher = Binding.Service<StartWatcher>("Azure.Automation.StartWatcher");
