import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetOdbNetwork } from "./GetOdbNetwork.ts";

/**
 * HTTP implementation of {@link GetOdbNetwork}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GetOdbNetwork
 */
export const GetOdbNetworkHttp = Layer.effect(
  GetOdbNetwork,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GetOdbNetwork",
    operation: oracle.getProjectsLocationsOdbNetworks,
  }),
);
