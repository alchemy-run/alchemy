import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestTpm } from "./AttestTpm.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestTpm} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestTpm
 */
export const AttestTpmHttp = Layer.effect(
  AttestTpm,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestTpm",
    operation: att.AttestationAttestTpm,
    grant: undefined,
  }),
);
