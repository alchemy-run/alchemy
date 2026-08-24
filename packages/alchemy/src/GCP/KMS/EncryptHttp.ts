import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Layer from "effect/Layer";
import { makeCryptoKeyHttpBinding } from "./BindingHttp.ts";
import { Encrypt } from "./Encrypt.ts";

/**
 * HTTP implementation of {@link Encrypt}.
 *
 * @layer
 * @provides GCP.KMS.Encrypt
 */
export const EncryptHttp = Layer.effect(
  Encrypt,
  makeCryptoKeyHttpBinding({
    tag: "GCP.KMS.Encrypt",
    operation: kms.encryptProjectsLocationsKeyRingsCryptoKeys,
  }),
);
