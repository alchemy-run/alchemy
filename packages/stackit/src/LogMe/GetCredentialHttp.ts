import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetCredential } from "./GetCredential.ts";

/**
 * HTTP implementation of {@link GetCredential}.
 *
 * @layer
 * @provides Stackit.LogMe.GetCredential
 */
export const GetCredentialHttp = Layer.effect(
  GetCredential,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.GetCredential",
    permission: "logme.credential.get",
    operation: logme.getCredentials,
  }),
);
