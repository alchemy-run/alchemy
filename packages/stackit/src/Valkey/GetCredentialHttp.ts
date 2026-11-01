import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetCredential } from "./GetCredential.ts";

/**
 * HTTP implementation of {@link GetCredential}.
 *
 * @layer
 * @provides Stackit.Valkey.GetCredential
 */
export const GetCredentialHttp = Layer.effect(
  GetCredential,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.GetCredential",
    permission: "key-value-store.credential.get",
    operation: valkey.getCredentials,
  }),
);
