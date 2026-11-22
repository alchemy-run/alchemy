import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface PutManifestRequest extends Omit<
  acr.CreateContainerRegistryManifestRequest,
  "endpoint"
> {}

/**
 * Push an image manifest (or index) under a tag or digest to an Azure Container Registry repository. Every blob it names must already be in the repository (see `UploadBlob`).
 *
 * Binding assigns a custom role (`AzureContainerRegistryPushRole`, one per
 * stack) on the registry only, with exactly `registries/push/write` and the data action `registries/repositories/content/write`, so it works whether the
 * registry uses legacy or ABAC repository permissions. The smallest built-in roles, **AcrPush** and **Container Registry Repository Writer**, also grant pull and metadata access.
 * The registry is the narrowest scope Azure RBAC can assign on.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Calls trade
 * the host's Entra token for a registry token scoped to the repository.
 * Provide {@link PutManifestHttp}.
 *
 * ### Calling PutManifest
 * **Example:** PutManifest from a Function
 * ```typescript
 * // init
 * const putManifest = yield* Azure.ContainerRegistry.PutManifest(registry);
 *
 * // runtime
 * const { dockerContentDigest } = yield* putManifest({
 *   name: "app",
 *   reference: "v1",
 *   contentType: "application/vnd.oci.image.manifest.v1+json",
 *   payload: new TextEncoder().encode(JSON.stringify(manifest)),
 * });
 * ```
 *
 * ### Providing the layer
 * **Example:** PutManifest on an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     const putManifest = yield* Azure.ContainerRegistry.PutManifest(registry);
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.PutManifestHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface PutManifest extends Binding.Service<
  PutManifest,
  "Azure.ContainerRegistry.PutManifest",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: PutManifestRequest,
    ) => Effect.Effect<
      acr.CreateContainerRegistryManifestResponse,
      acr.CreateContainerRegistryManifestError,
      RuntimeContext
    >
  >
> {}

export const PutManifest = Binding.Service<PutManifest>("Azure.ContainerRegistry.PutManifest");
