import * as att from "@distilled.cloud/azure/attestation-data";
import * as Layer from "effect/Layer";
import { makeAttestationHttpBinding } from "./BindingHttp.ts";
import { GetMetadataConfiguration } from "./GetMetadataConfiguration.ts";

/**
 * Implementation of {@link GetMetadataConfiguration} over the distilled
 * `attestation-data` data plane. Assigns no role (the endpoint is
 * anonymous).
 *
 * @layer
 * @provides Azure.Attestation.GetMetadataConfiguration
 */
export const GetMetadataConfigurationHttp = Layer.effect(
  GetMetadataConfiguration,
  makeAttestationHttpBinding({
    tag: "Azure.Attestation.GetMetadataConfiguration",
    operation: att.GetMetadataConfiguration,
    grant: undefined,
  }),
);
