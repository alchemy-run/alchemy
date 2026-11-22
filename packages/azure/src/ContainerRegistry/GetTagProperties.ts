import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface GetTagPropertiesRequest extends Omit<
  acr.GetContainerRegistryTagPropertiesRequest,
  "endpoint"
> {}

/**
 * Read the properties of a tag in an Azure Container Registry repository (its digest, times, changeable attributes).
 *
 * Binding assigns a custom role (`AzureContainerRegistryReadMetadataRole`, one per
 * stack) on the registry only, with exactly `registries/metadata/read` and the data action `registries/repositories/metadata/read`, so it works whether the
 * registry uses legacy or ABAC repository permissions. The smallest built-in roles, **AcrPull** and **Container Registry Repository Reader**, also grant content reads.
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link GetTagPropertiesHttp}.
 *
 * ### Calling GetTagProperties
 * **Example:** GetTagProperties from a Function
 * ```typescript
 * // init
 * const getTagProperties = yield* Azure.ContainerRegistry.GetTagProperties(registry);
 *
 * // runtime
 * const { tag } = yield* getTagProperties({ name: "app", reference: "v1" });
 * ```
 *
 * ### Providing the layer
 * **Example:** GetTagProperties on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const getTagProperties = yield* Azure.ContainerRegistry.GetTagProperties(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.GetTagPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface GetTagProperties extends Binding.Service<
  GetTagProperties,
  "Azure.ContainerRegistry.GetTagProperties",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: GetTagPropertiesRequest,
    ) => Effect.Effect<
      acr.ArtifactTagProperties,
      acr.GetContainerRegistryTagPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetTagProperties = Binding.Service<GetTagProperties>(
  "Azure.ContainerRegistry.GetTagProperties",
);
