import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { AttestationRole, makeAttestationHttpBinding } from "./BindingHttp.ts";
import { GetTcbBaseline } from "./GetTcbBaseline.ts";

/**
 * Implementation of {@link GetTcbBaseline} over the distilled
 * `attestation-data` data plane. Assigns the custom
 * `AzureAttestationPolicyReadRole` on the provider.
 *
 * @layer
 * @provides Azure.Attestation.GetTcbBaseline
 */
export const GetTcbBaselineHttp = Layer.effect(
  GetTcbBaseline,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.GetTcbBaseline",
    operation: att.GetTcbBaseline,
    grant: AttestationRole.PolicyRead,
  }),
);
