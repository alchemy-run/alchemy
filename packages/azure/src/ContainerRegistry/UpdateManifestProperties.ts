import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface UpdateManifestPropertiesRequest extends Omit<
  acr.UpdateContainerRegistryManifestPropertiesRequest,
  "endpoint"
> {}

/**
 * Change the attributes of a manifest in an Azure Container Registry repository (lock it against writes or deletes).
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
 * Provide {@link UpdateManifestPropertiesHttp}.
 *
 * ### Calling UpdateManifestProperties
 * **Example:** UpdateManifestProperties from a Function
 * ```typescript
 * // init
 * const updateManifestProperties = yield* Azure.ContainerRegistry.UpdateManifestProperties(registry);
 *
 * // runtime
 * yield* updateManifestProperties({ name: "app", digest, deleteEnabled: false });
 * ```
 *
 * ### Providing the layer
 * **Example:** UpdateManifestProperties on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const updateManifestProperties = yield* Azure.ContainerRegistry.UpdateManifestProperties(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.UpdateManifestPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface UpdateManifestProperties extends Binding.Service<
  UpdateManifestProperties,
  "Azure.ContainerRegistry.UpdateManifestProperties",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: UpdateManifestPropertiesRequest,
    ) => Effect.Effect<
      acr.ArtifactManifestProperties,
      acr.UpdateContainerRegistryManifestPropertiesError,
      RuntimeContext
    >
  >
> {}

export const UpdateManifestProperties = Binding.Service<UpdateManifestProperties>(
  "Azure.ContainerRegistry.UpdateManifestProperties",
);
