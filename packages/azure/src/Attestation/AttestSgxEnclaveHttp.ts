import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestSgxEnclave } from "./AttestSgxEnclave.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestSgxEnclave} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestSgxEnclave
 */
export const AttestSgxEnclaveHttp = Layer.effect(
  AttestSgxEnclave,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestSgxEnclave",
    operation: att.AttestationAttestSgxEnclave,
    grant: undefined,
  }),
);
