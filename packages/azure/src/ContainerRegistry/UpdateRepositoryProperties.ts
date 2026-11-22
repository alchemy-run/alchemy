import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface UpdateRepositoryPropertiesRequest extends Omit<
  acr.UpdateContainerRegistryPropertiesRequest,
  "endpoint"
> {}

/**
 * Change the attributes of an Azure Container Registry repository (lock it against writes or deletes, hide it from lists).
 *
 * Binding assigns a custom role (`AzureContainerRegistryWriteMetadataRole`, one per
 * stack) on the registry only, with exactly `registries/metadata/write` and the data action `registries/repositories/metadata/write`, so it works whether the
 * registry uses legacy or ABAC repository permissions. The smallest built-in role, **Container Registry Repository Writer**, also grants content reads and writes.
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link UpdateRepositoryPropertiesHttp}.
 *
 * ### Calling UpdateRepositoryProperties
 * **Example:** UpdateRepositoryProperties from a Function
 * ```typescript
 * // init
 * const updateRepositoryProperties = yield* Azure.ContainerRegistry.UpdateRepositoryProperties(registry);
 *
 * // runtime
 * yield* updateRepositoryProperties({ name: "app", writeEnabled: false });
 * ```
 *
 * ### Providing the layer
 * **Example:** UpdateRepositoryProperties on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const updateRepositoryProperties = yield* Azure.ContainerRegistry.UpdateRepositoryProperties(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.UpdateRepositoryPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface UpdateRepositoryProperties extends Binding.Service<
  UpdateRepositoryProperties,
  "Azure.ContainerRegistry.UpdateRepositoryProperties",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: UpdateRepositoryPropertiesRequest,
    ) => Effect.Effect<
      acr.ContainerRepositoryProperties,
      acr.UpdateContainerRegistryPropertiesError,
      RuntimeContext
    >
  >
> {}

export const UpdateRepositoryProperties = Binding.Service<UpdateRepositoryProperties>(
  "Azure.ContainerRegistry.UpdateRepositoryProperties",
);
