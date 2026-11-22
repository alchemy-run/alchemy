import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface ListRepositoriesRequest extends Omit<
  acr.GetContainerRegistryRepositoriesRequest,
  "endpoint"
> {}

/**
 * List the repositories of an Azure Container Registry (one page; pass `last` and `n` to page).
 *
 * Binding assigns a custom role (`AzureContainerRegistryListCatalogRole`, one per
 * stack) on the registry only, with exactly `registries/metadata/read` and the data action `registries/catalog/read`, so it works whether the
 * registry uses legacy or ABAC repository permissions. In ABAC mode this matches **Container Registry Repository Catalog Lister**; the custom role also covers legacy-mode registries.
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link ListRepositoriesHttp}.
 *
 * ### Calling ListRepositories
 * **Example:** ListRepositories from a Function
 * ```typescript
 * // init
 * const listRepositories = yield* Azure.ContainerRegistry.ListRepositories(registry);
 *
 * // runtime
 * const { repositories } = yield* listRepositories();
 * ```
 *
 * ### Providing the layer
 * **Example:** ListRepositories on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const listRepositories = yield* Azure.ContainerRegistry.ListRepositories(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.ListRepositoriesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface ListRepositories extends Binding.Service<
  ListRepositories,
  "Azure.ContainerRegistry.ListRepositories",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request?: ListRepositoriesRequest,
    ) => Effect.Effect<acr.Repositories, acr.GetContainerRegistryRepositoriesError, RuntimeContext>
  >
> {}

export const ListRepositories = Binding.Service<ListRepositories>(
  "Azure.ContainerRegistry.ListRepositories",
);
