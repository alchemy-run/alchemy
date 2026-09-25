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
    // No IAM permission governs users.sshPublicKeys.get; it only reads the
    // caller's own account.
    iam: [],
    operation: oslogin.getUsersSshPublicKeys,
  }),
);
