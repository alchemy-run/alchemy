import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
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
 * const get = yield* GCP.OracleDatabase.GetGoldengateConnection(conn);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetGoldengateConnection extends Binding.Service<
  GetGoldengateConnection,
  "GCP.OracleDatabase.GetGoldengateConnection",
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
  "GCP.OracleDatabase.GetGoldengateConnection",
);

/**
 * HTTP implementation of {@link GetGoldengateConnection}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateConnection
 */
export const GetGoldengateConnectionHttp = Layer.effect(
  GetGoldengateConnection,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateConnection",
    operation: oracle.getProjectsLocationsGoldengateConnections,
    iam: { role: "roles/oracledatabase.goldenGateConnectionViewer" },
  }),
);
