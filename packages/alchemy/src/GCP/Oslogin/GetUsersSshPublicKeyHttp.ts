import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import * as Layer from "effect/Layer";
import { makeUsersSshPublicKeyHttpBinding } from "./BindingHttp.ts";
import { GetUsersSshPublicKey } from "./GetUsersSshPublicKey.ts";

/**
 * HTTP implementation of {@link GetUsersSshPublicKey}.
 *
 * @layer
 * @provides GCP.Oslogin.GetUsersSshPublicKey
 */
export const GetUsersSshPublicKeyHttp = Layer.effect(
  GetUsersSshPublicKey,
  makeUsersSshPublicKeyHttpBinding({
    tag: "GCP.Oslogin.GetUsersSshPublicKey",
    operation: oslogin.getUsersSshPublicKeys,
  }),
);
