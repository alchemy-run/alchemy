import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface PutLockRequest extends Omit<appconfig.PutLockRequest, "endpoint"> {}

/**
 * Lock one key-value of an Azure App Configuration store, so it cannot be
 * changed or deleted until it is unlocked with `DeleteLock`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueWriteRole`, one per stack) with
 * exactly the data action `keyValues/write`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PutLockHttp}.
 *
 * ### Calling PutLock
 * **Example:** PutLock from a Function
 * ```typescript
 * // init
 * const putLock = yield* Azure.AppConfiguration.PutLock(store);
 *
 * // runtime
 * const locked = yield* putLock({ key: "App:Color", label: "prod" });
 * // …provided with Effect.provide(Azure.AppConfiguration.PutLockHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface PutLock extends Binding.Service<
  PutLock,
  "Azure.AppConfiguration.PutLock",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: PutLockRequest,
    ) => Effect.Effect<appconfig.PutLockResponse, appconfig.PutLockError, RuntimeContext>
  >
> {}

export const PutLock = Binding.Service<PutLock>("Azure.AppConfiguration.PutLock");
