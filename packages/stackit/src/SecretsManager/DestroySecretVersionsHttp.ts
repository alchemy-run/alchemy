import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { DestroySecretVersions } from "./DestroySecretVersions.ts";

/**
 * HTTP implementation of {@link DestroySecretVersions}.
 *
 * @layer
 * @provides Stackit.SecretsManager.DestroySecretVersions
 */
export const DestroySecretVersionsHttp = Layer.effect(
  DestroySecretVersions,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.DestroySecretVersions",
    write: true,
    operation: kv.destroySecretVersions,
  }),
);
