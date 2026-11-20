import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
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
 * const get = yield* GCP.OracleDatabase.GetOdbNetworksOdbSubnet(subnet);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetOdbNetworksOdbSubnet extends Binding.Service<
  GetOdbNetworksOdbSubnet,
  "GCP.OracleDatabase.GetOdbNetworksOdbSubnet",
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
  "GCP.OracleDatabase.GetOdbNetworksOdbSubnet",
);

/**
 * HTTP implementation of {@link GetOdbNetworksOdbSubnet}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetOdbNetworksOdbSubnet
 */
export const GetOdbNetworksOdbSubnetHttp = Layer.effect(
  GetOdbNetworksOdbSubnet,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetOdbNetworksOdbSubnet",
    operation: oracle.getProjectsLocationsOdbNetworksOdbSubnets,
    iam: { role: "roles/oracledatabase.odbSubnetViewer" },
  }),
);
