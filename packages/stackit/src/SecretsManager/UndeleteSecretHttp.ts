import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Layer from "effect/Layer";
import { makeVaultOperationBinding } from "./BindingHttp.ts";
import { UndeleteSecret } from "./UndeleteSecret.ts";

/**
 * HTTP implementation of {@link UndeleteSecret}.
 *
 * @layer
 * @provides Stackit.SecretsManager.UndeleteSecret
 */
export const UndeleteSecretHttp = Layer.effect(
  UndeleteSecret,
  makeVaultOperationBinding({
    tag: "Stackit.SecretsManager.UndeleteSecret",
    write: true,
    operation: kv.undeleteSecretVersions,
  }),
);
