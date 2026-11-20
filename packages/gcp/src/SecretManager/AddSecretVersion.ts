import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";

export interface AddSecretVersionRequest {
  /**
   * Secret payload. `data` is the standard-base64 encoding of at most
   * 64KiB of bytes.
   */
  payload: secretmanager.SecretPayload;
}

/**
 * Runtime binding for Secret Manager `secrets.addVersion`.
 *
 * Bind this operation to a {@link Secret} or {@link LocationsSecret} in a
 * Function/Action init phase.
 * Provide {@link AddSecretVersionHttp}.
 *
 * ### Adding Secret Versions
 * **Example:** Add a version
 * ```typescript
 * const addVersion = yield* GCP.SecretManager.AddSecretVersion(secret);
 * yield* addVersion({ payload: { data: btoa("hello") } });
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface AddSecretVersion extends Binding.Service<
  AddSecretVersion,
  "GCP.SecretManager.AddSecretVersion",
  (
    secret: Secret | LocationsSecret,
  ) => Effect.Effect<
    (
      request: AddSecretVersionRequest,
    ) => Effect.Effect<
      secretmanager.SecretVersion,
      secretmanager.AddVersionProjectsSecretsError,
      RuntimeContext
    >
  >
> {}

export const AddSecretVersion = Binding.Service<AddSecretVersion>(
  "GCP.SecretManager.AddSecretVersion",
);

/**
 * HTTP implementation of {@link AddSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AddSecretVersion
 */
export const AddSecretVersionHttp = Layer.effect(
  AddSecretVersion,
  makeSecretHttpBinding<
    secretmanager.AddVersionProjectsSecretsRequest,
    secretmanager.SecretVersion,
    secretmanager.AddVersionProjectsSecretsError,
    AddSecretVersionRequest
  >({
    tag: "GCP.SecretManager.AddSecretVersion",
    iam: {
      role: "roles/secretmanager.secretVersionAdder",
      on: "secretmanager.secret",
    },
    operation: secretmanager.addVersionProjectsSecrets,
    toInput: (secretName, request) => ({
      parent: secretName,
      body: { payload: request?.payload },
    }),
  }),
);
