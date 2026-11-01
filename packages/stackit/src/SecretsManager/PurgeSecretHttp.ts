import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { PurgeSecret } from "./PurgeSecret.ts";

/**
 * HTTP implementation of {@link PurgeSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.PurgeSecret
 */
export const PurgeSecretHttp = Layer.effect(
  PurgeSecret,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.PurgeSecret",
    write: true,
    operation: kv.deleteSecretMetadata,
  }),
);
