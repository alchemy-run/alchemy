import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface DeleteBlobRequest extends Omit<
  acr.DeleteContainerRegistryBlobBlobRequest,
  "endpoint"
> {}

/**
 * Delete a blob (by digest) from an Azure Container Registry repository.
 *
 * Binding assigns a custom role (`AzureContainerRegistryDeleteRole`, one per
 * stack) on the registry only, with exactly `registries/artifacts/delete` and the data actions `registries/repositories/content/delete` and `registries/repositories/metadata/delete`, so it works whether the
 * registry uses legacy or ABAC repository permissions. The smallest built-in role for ABAC registries, **Container Registry Repository Contributor**, also grants reads and writes.
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link DeleteBlobHttp}.
 *
 * ### Calling DeleteBlob
 * **Example:** DeleteBlob from a Function
 * ```typescript
 * // init
 * const deleteBlob = yield* Azure.ContainerRegistry.DeleteBlob(registry);
 *
 * // runtime
 * yield* deleteBlob({ name: "app", digest });
 * ```
 *
 * ### Providing the layer
 * **Example:** DeleteBlob on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const deleteBlob = yield* Azure.ContainerRegistry.DeleteBlob(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.DeleteBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface DeleteBlob extends Binding.Service<
  DeleteBlob,
  "Azure.ContainerRegistry.DeleteBlob",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: DeleteBlobRequest,
    ) => Effect.Effect<
      acr.DeleteContainerRegistryBlobBlobResponse,
      acr.DeleteContainerRegistryBlobBlobError,
      RuntimeContext
    >
  >
> {}

export const DeleteBlob = Binding.Service<DeleteBlob>("Azure.ContainerRegistry.DeleteBlob");
