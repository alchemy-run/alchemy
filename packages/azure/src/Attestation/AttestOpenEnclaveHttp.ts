import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestOpenEnclave } from "./AttestOpenEnclave.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestOpenEnclave} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestOpenEnclave
 */
export const AttestOpenEnclaveHttp = Layer.effect(
  AttestOpenEnclave,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestOpenEnclave",
    operation: att.AttestationAttestOpenEnclave,
    grant: undefined,
  }),
);
