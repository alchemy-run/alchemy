import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface UpdateTagAttributesRequest extends Omit<
  acr.UpdateContainerRegistryTagAttributesRequest,
  "endpoint"
> {}

/**
 * Change the attributes of a tag in an Azure Container Registry repository (lock it against writes or deletes).
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
 * Provide {@link UpdateTagAttributesHttp}.
 *
 * ### Calling UpdateTagAttributes
 * **Example:** UpdateTagAttributes from a Function
 * ```typescript
 * // init
 * const updateTagAttributes = yield* Azure.ContainerRegistry.UpdateTagAttributes(registry);
 *
 * // runtime
 * yield* updateTagAttributes({ name: "app", reference: "v1", deleteEnabled: false });
 * ```
 *
 * ### Providing the layer
 * **Example:** UpdateTagAttributes on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const updateTagAttributes = yield* Azure.ContainerRegistry.UpdateTagAttributes(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.UpdateTagAttributesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface UpdateTagAttributes extends Binding.Service<
  UpdateTagAttributes,
  "Azure.ContainerRegistry.UpdateTagAttributes",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: UpdateTagAttributesRequest,
    ) => Effect.Effect<
      acr.ArtifactTagProperties,
      acr.UpdateContainerRegistryTagAttributesError,
      RuntimeContext
    >
  >
> {}

export const UpdateTagAttributes = Binding.Service<UpdateTagAttributes>(
  "Azure.ContainerRegistry.UpdateTagAttributes",
);
