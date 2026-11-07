import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SecretBindingTarget } from "./BindingHttp.ts";
import type { ReadSecretClient } from "./ReadSecret.ts";
import { makeSecretAccessBinding, readWriteSecretGrants } from "./SecretHttp.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

export interface ReadWriteSecretClient extends ReadSecretClient, WriteSecretClient {}

/**
 * Read and version-management access to a Secret Manager {@link Secret}.
 * No predefined role covers both, so this grants
 * `roles/secretmanager.secretAccessor` and
 * `roles/secretmanager.secretVersionManager` on the secret only.
 *
 * ### Reading and rotating
 * **Example:** Rotate and read back
 * ```typescript
 * const apiKey = yield* GCP.SecretManager.ReadWriteSecret(secret);
 * const current = yield* apiKey.access();
 * yield* apiKey.addVersion(rotate(current));
 * // …provided with Effect.provide(GCP.SecretManager.ReadWriteSecretHttp)
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface ReadWriteSecret extends Binding.Service<
  ReadWriteSecret,
  "GCP.SecretManager.ReadWriteSecret",
  (secret: SecretBindingTarget) => Effect.Effect<ReadWriteSecretClient>
> {}

export const ReadWriteSecret = Binding.Service<ReadWriteSecret>(
  "GCP.SecretManager.ReadWriteSecret",
);

/**
 * HTTP implementation of {@link ReadWriteSecret} over the Secret Manager REST API.
 *
 * @layer
 * @provides GCP.SecretManager.ReadWriteSecret
 * @category SecretManager
 */
export const ReadWriteSecretHttp = Layer.effect(
  ReadWriteSecret,
  makeSecretAccessBinding({
    tag: "GCP.SecretManager.ReadWriteSecret",
    grants: readWriteSecretGrants,
    makeClient: (helpers, name) => ({
      ...helpers.makeRead(name),
      ...helpers.makeWrite(name),
    }),
  }),
);
