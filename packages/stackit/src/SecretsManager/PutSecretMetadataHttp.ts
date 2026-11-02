import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { PutSecretMetadata } from "./PutSecretMetadata.ts";

/**
 * HTTP implementation of {@link PutSecretMetadata}.
 *
 * @layer
 * @provides Stackit.SecretsManager.PutSecretMetadata
 */
export const PutSecretMetadataHttp = Layer.effect(
  PutSecretMetadata,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.PutSecretMetadata",
    write: true,
    operation: kv.putSecretMetadata,
  }),
);
