import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { OdbNetworksOdbSubnet } from "./OdbNetworksOdbSubnet.ts";

export interface GetOdbNetworksOdbSubnetRequest extends Omit<
  oracle.GetProjectsLocationsOdbNetworksOdbSubnetsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `odbSubnets.get`.
 *
 * ### Observing an ODB Subnet
 * **Example:** Read the bound subnet
 * ```typescript
 * const get = yield* GCP.Oracledatabase.GetOdbNetworksOdbSubnet(subnet);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface GetOdbNetworksOdbSubnet extends Binding.Service<
  GetOdbNetworksOdbSubnet,
  "GCP.Oracledatabase.GetOdbNetworksOdbSubnet",
  (
    subnet: OdbNetworksOdbSubnet,
  ) => Effect.Effect<
    (
      request?: GetOdbNetworksOdbSubnetRequest,
    ) => Effect.Effect<
      oracle.OdbSubnet,
      oracle.GetProjectsLocationsOdbNetworksOdbSubnetsError,
      RuntimeContext
    >
  >
> {}

export const GetOdbNetworksOdbSubnet = Binding.Service<GetOdbNetworksOdbSubnet>(
  "GCP.Oracledatabase.GetOdbNetworksOdbSubnet",
);
