import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { GoldengateConnection } from "./GoldengateConnection.ts";

export interface GetGoldengateConnectionRequest extends Omit<
  oracle.GetProjectsLocationsGoldengateConnectionsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `goldengateConnections.get`.
 *
 * ### Observing GoldenGate connections
 * **Example:** Read the bound connection
 * ```typescript
 * const get = yield* GCP.Oracledatabase.GetGoldengateConnection(conn);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface GetGoldengateConnection extends Binding.Service<
  GetGoldengateConnection,
  "GCP.Oracledatabase.GetGoldengateConnection",
  (
    connection: GoldengateConnection,
  ) => Effect.Effect<
    (
      request?: GetGoldengateConnectionRequest,
    ) => Effect.Effect<
      oracle.GoldengateConnection,
      oracle.GetProjectsLocationsGoldengateConnectionsError,
      RuntimeContext
    >
  >
> {}

export const GetGoldengateConnection = Binding.Service<GetGoldengateConnection>(
  "GCP.Oracledatabase.GetGoldengateConnection",
);
