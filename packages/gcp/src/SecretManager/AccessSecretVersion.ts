import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";

export interface AccessSecretVersionRequest {
  /**
   * Version id or alias. `latest` is the most recently created version.
   * @default "latest"
   */
  version?: string;
}

/**
 * Runtime binding for Secret Manager `secrets.versions.access`.
 *
 * Bind this operation to a {@link Secret} or {@link LocationsSecret} in a
 * Function/Action init phase.
 * Provide {@link AccessSecretVersionHttp}. Payload `data` is standard
 * base64.
 *
 * ### Accessing Secret Versions
 * **Example:** Access the latest version
 * ```typescript
 * const access = yield* GCP.SecretManager.AccessSecretVersion(secret);
 * const { payload } = yield* access();
 * ```
 *
 * **Example:** Access a specific version
 * ```typescript
 * const access = yield* GCP.SecretManager.AccessSecretVersion(secret);
 * const { payload } = yield* access({ version: "1" });
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface AccessSecretVersion extends Binding.Service<
  AccessSecretVersion,
  "GCP.SecretManager.AccessSecretVersion",
  (
    secret: Secret | LocationsSecret,
  ) => Effect.Effect<
    (
      request?: AccessSecretVersionRequest,
    ) => Effect.Effect<
      secretmanager.AccessSecretVersionResponse,
      secretmanager.AccessProjectsSecretsVersionsError,
      RuntimeContext
    >
  >
> {}

export const AccessSecretVersion = Binding.Service<AccessSecretVersion>(
  "GCP.SecretManager.AccessSecretVersion",
);

/**
 * HTTP implementation of {@link AccessSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AccessSecretVersion
 */
export const AccessSecretVersionHttp = Layer.effect(
  AccessSecretVersion,
  makeSecretHttpBinding<
    secretmanager.AccessProjectsSecretsVersionsRequest,
    secretmanager.AccessSecretVersionResponse,
    secretmanager.AccessProjectsSecretsVersionsError,
    AccessSecretVersionRequest
  >({
    tag: "GCP.SecretManager.AccessSecretVersion",
    iam: {
      role: "roles/secretmanager.secretAccessor",
      on: "secretmanager.secret",
    },
    operation: secretmanager.accessProjectsSecretsVersions,
    toInput: (secretName, request) => ({
      name: `${secretName}/versions/${request?.version ?? "latest"}`,
    }),
  }),
);
