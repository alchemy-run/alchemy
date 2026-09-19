import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetOdbNetworksOdbSubnet } from "./GetOdbNetworksOdbSubnet.ts";

/**
 * HTTP implementation of {@link GetOdbNetworksOdbSubnet}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GetOdbNetworksOdbSubnet
 */
export const GetOdbNetworksOdbSubnetHttp = Layer.effect(
  GetOdbNetworksOdbSubnet,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GetOdbNetworksOdbSubnet",
    operation: oracle.getProjectsLocationsOdbNetworksOdbSubnets,
  }),
);
