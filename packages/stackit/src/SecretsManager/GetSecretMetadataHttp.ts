import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { GetSecretMetadata } from "./GetSecretMetadata.ts";

/**
 * HTTP implementation of {@link GetSecretMetadata}.
 *
 * @layer
 * @provides Stackit.SecretsManager.GetSecretMetadata
 */
export const GetSecretMetadataHttp = Layer.effect(
  GetSecretMetadata,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.GetSecretMetadata",
    write: false,
    operation: kv.getSecretMetadata,
  }),
);
