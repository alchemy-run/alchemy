import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestAzureGuest } from "./AttestAzureGuest.ts";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AttestAzureGuest} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.AttestAzureGuest
 */
export const AttestAzureGuestHttp = Layer.effect(
  AttestAzureGuest,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.AttestAzureGuest",
    operation: att.AttestationAttestAzureGuest,
    grant: undefined,
  }),
);
