import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestTdxVm } from "./AttestTdxVm.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestTdxVm} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestTdxVm
 */
export const AttestTdxVmHttp = Layer.effect(
  AttestTdxVm,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestTdxVm",
    operation: att.AttestationAttestTdxVm,
    grant: undefined,
  }),
);
