import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { createCloudflareApi } from "./api.ts";
import type { Secret as CloudflareSecret, SecretProps } from "./secret.ts";
import { findSecretsStoreByName, SecretsStore } from "./secrets-store.ts";

/**
 * Properties for referencing an existing Secret in a Secrets Store (without managing its value)
 */
export type SecretRefProps = Omit<SecretProps, "value" | "delete">;

/**
 * Output for a Secret reference bound to a Worker. Matches the binding shape used by Cloudflare.
 */
export interface SecretRef
  extends Resource<"cloudflare::SecretRef">,
    Omit<CloudflareSecret, "value"> {}

/**
 * SecretRef references an existing secret by name in a Secrets Store.
 *
 * It does not create or update the secret value – use {@link Secret} for that.
 *
 * Behavior:
 * - Resolves the target secrets store ID (defaults to Cloudflare's `default_secrets_store`, creating/adopting if needed)
 * - Exposes a binding of type `secrets_store_secret` usable in Worker bindings
 * - Update with a different name will trigger resource replacement
 * - Delete is a no-op in Cloudflare (resource removed from state only)
 *
 * @example
 * // Reference an existing secret in the default store and bind to a Worker
 * const apiKeyRef = await SecretRef("api-key-ref", { name: "API_KEY" });
 * const worker = await Worker("my-worker", {
 *   entrypoint: "./src/worker.ts",
 *   url: true,
 *   bindings: {
 *     API_KEY: apiKeyRef,
 *   },
 * });
 */
export function SecretRef(id: string, props: SecretRefProps): Promise<SecretRef> {
  return _SecretRef(id, props);
}

const _SecretRef = Resource(
  "cloudflare::SecretRef",
  async function (
    this: Context<SecretRef>,
    id: string,
    props: SecretRefProps,
  ): Promise<SecretRef> {
    const api = await createCloudflareApi(props);

    const secretName =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    if (this.phase === "update" && this.output.name !== secretName) {
      this.replace();
    }

    const storeId =
      props.store?.id ??
      (await findSecretsStoreByName(api, SecretsStore.Default))?.id ??
      (
        await SecretsStore("default-store", {
          name: SecretsStore.Default,
          adopt: true,
          delete: false,
        })
      )?.id!;

    if (this.phase === "delete") {
      // Reference only – do not delete underlying secret
      return this.destroy();
    }

    const createdAt =
      this.phase === "update"
        ? this.output?.createdAt || Date.now()
        : Date.now();

    return this({
      type: "secrets_store_secret",
      name: secretName,
      storeId,
      store: props.store,
      createdAt,
      modifiedAt: Date.now(),
    });
  },
);


