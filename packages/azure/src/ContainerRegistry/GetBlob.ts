import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface GetBlobRequest extends Omit<acr.GetContainerRegistryBlobBlobRequest, "endpoint"> {}

/**
 * Download a blob (an image layer or config) by digest from an Azure Container Registry repository.
 *
 * Binding assigns a custom role (`AzureContainerRegistryPullRole`, one per
 * stack) on the registry only, with exactly `registries/pull/read` (legacy registry permissions) and the data action `registries/repositories/content/read` (ABAC repository permissions), so it works whether the
 * registry uses legacy or ABAC repository permissions. The smallest built-in roles, **AcrPull** and **Container Registry Repository Reader**, also grant more (Repository Reader reads metadata).
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link GetBlobHttp}.
 *
 * ### Calling GetBlob
 * **Example:** GetBlob from a Function
 * ```typescript
 * // init
 * const getBlob = yield* Azure.ContainerRegistry.GetBlob(registry);
 *
 * // runtime
 * const { body } = yield* getBlob({ name: "app", digest: manifest.config!.digest! });
 * ```
 *
 * ### Providing the layer
 * **Example:** GetBlob on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const getBlob = yield* Azure.ContainerRegistry.GetBlob(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.GetBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface GetBlob extends Binding.Service<
  GetBlob,
  "Azure.ContainerRegistry.GetBlob",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: GetBlobRequest,
    ) => Effect.Effect<
      acr.GetContainerRegistryBlobBlobResponse,
      acr.GetContainerRegistryBlobBlobError,
      RuntimeContext
    >
  >
> {}

export const GetBlob = Binding.Service<GetBlob>("Azure.ContainerRegistry.GetBlob");
