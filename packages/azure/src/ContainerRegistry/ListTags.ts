import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface ListTagsRequest extends Omit<acr.GetContainerRegistryTagsRequest, "endpoint"> {}

/**
 * List the tags of an Azure Container Registry repository (one page; pass `last` and `n` to page).
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
 * Provide {@link ListTagsHttp}.
 *
 * ### Calling ListTags
 * **Example:** ListTags from a Function
 * ```typescript
 * // init
 * const listTags = yield* Azure.ContainerRegistry.ListTags(registry);
 *
 * // runtime
 * const { tags } = yield* listTags({ name: "app", orderby: "timedesc" });
 * ```
 *
 * ### Providing the layer
 * **Example:** ListTags on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const listTags = yield* Azure.ContainerRegistry.ListTags(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.ListTagsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface ListTags extends Binding.Service<
  ListTags,
  "Azure.ContainerRegistry.ListTags",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: ListTagsRequest,
    ) => Effect.Effect<acr.TagList, acr.GetContainerRegistryTagsError, RuntimeContext>
  >
> {}

export const ListTags = Binding.Service<ListTags>("Azure.ContainerRegistry.ListTags");
