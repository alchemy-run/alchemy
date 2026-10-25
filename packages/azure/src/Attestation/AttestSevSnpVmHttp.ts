import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestSevSnpVm } from "./AttestSevSnpVm.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestSevSnpVm} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestSevSnpVm
 */
export const AttestSevSnpVmHttp = Layer.effect(
  AttestSevSnpVm,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestSevSnpVm",
    operation: att.AttestationAttestSevSnpVm,
    grant: undefined,
  }),
);
