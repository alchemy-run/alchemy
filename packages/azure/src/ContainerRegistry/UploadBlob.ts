import type * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Registry } from "./Registry.ts";

export interface UploadBlobRequest {
  /** Repository name (including any namespace), e.g. `app` or `team/app`. */
  name: string;
  /** The blob's bytes, sent in one request. */
  body: Uint8Array;
  /**
   * `sha256:<hex>` digest of `body`. Computed from `body` when omitted; the
   * registry rejects an upload whose bytes do not match.
   */
  digest?: string;
}

export interface UploadBlobResult {
  /** The digest the registry stored the blob under. */
  digest: string;
  /** Path of the stored blob, e.g. `/v2/app/blobs/sha256:…`. */
  location?: string;
}

/**
 * Upload a blob (an image layer or config) to an Azure Container Registry
 * repository in one request: starts an upload session
 * (`POST /v2/<name>/blobs/uploads/`) and completes it with the whole body
 * (`PUT <location>?digest=…`). Push the manifest that names the blob with
 * `PutManifest`.
 *
 * Binding assigns a custom role (`AzureContainerRegistryPushRole`, one per
 * stack) on the registry only, with exactly `registries/push/write` (legacy
 * registry permissions) and the data action
 * `registries/repositories/content/write` (ABAC repository permissions). The
 * smallest built-in roles, **AcrPush** and **Container Registry Repository
 * Writer**, also grant pull and metadata access. The registry is the
 * narrowest scope Azure RBAC can assign on. On a host with a managed
 * identity the role goes to that identity; any other host gets an Entra
 * service principal (see `AzureBindings`). Provide {@link UploadBlobHttp}.
 *
 * ### Calling UploadBlob
 * **Example:** Upload a config blob from a Function
 * ```typescript
 * // init
 * const uploadBlob = yield* Azure.ContainerRegistry.UploadBlob(registry);
 *
 * // runtime
 * const { digest } = yield* uploadBlob({
 *   name: "app",
 *   body: new TextEncoder().encode("{}"),
 * });
 * ```
 *
 * @binding
 * @category ContainerRegistry
 */
export interface UploadBlob extends Binding.Service<
  UploadBlob,
  "Azure.ContainerRegistry.UploadBlob",
  (
    registry: Registry,
  ) => Effect.Effect<
    (
      request: UploadBlobRequest,
    ) => Effect.Effect<
      UploadBlobResult,
      acr.ContainerRegistryBlobStartUploadError | acr.UploadContainerRegistryBlobCompleteError,
      RuntimeContext
    >
  >
> {}

export const UploadBlob = Binding.Service<UploadBlob>("Azure.ContainerRegistry.UploadBlob");
