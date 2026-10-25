import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface DeleteLockRequest extends Omit<appconfig.DeleteLockRequest, "endpoint"> {}

/**
 * Unlock one key-value of an Azure App Configuration store.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueWriteRole`, one per stack) with
 * exactly the data action `keyValues/write`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteLockHttp}.
 *
 * ### Calling DeleteLock
 * **Example:** DeleteLock from a Function
 * ```typescript
 * // init
 * const deleteLock = yield* Azure.AppConfiguration.DeleteLock(store);
 *
 * // runtime
 * const unlocked = yield* deleteLock({ key: "App:Color", label: "prod" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface DeleteLock extends Binding.Service<
  DeleteLock,
  "Azure.AppConfiguration.DeleteLock",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: DeleteLockRequest,
    ) => Effect.Effect<appconfig.DeleteLockResponse, appconfig.DeleteLockError, RuntimeContext>
  >
> {}

export const DeleteLock = Binding.Service<DeleteLock>("Azure.AppConfiguration.DeleteLock");
