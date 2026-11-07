import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConnectionHttpBinding } from "./BindingHttp.ts";
import type { Connection } from "./Connection.ts";

export interface GetConnectionRequest extends Omit<
  bigqueryconnection.GetProjectsLocationsConnectionsRequest,
  "name"
> {}

/**
 * Runtime binding for BigQuery Connection `connections.get`.
 *
 * Bind this operation to a {@link Connection} in a Function/Action init
 * phase. Provide {@link GetConnectionHttp}.
 *
 * ### Reading a Connection
 * **Example:** Get the bound connection
 * ```typescript
 * const getConnection = yield* GCP.BigQueryConnection.GetConnection(gcs);
 * const live = yield* getConnection();
 * ```
 *
 * @binding
 * @category BigQueryConnection
 */
export interface GetConnection extends Binding.Service<
  GetConnection,
  "GCP.BigQueryConnection.GetConnection",
  (
    connection: Connection,
  ) => Effect.Effect<
    (
      request?: GetConnectionRequest,
    ) => Effect.Effect<
      bigqueryconnection.Connection,
      bigqueryconnection.GetProjectsLocationsConnectionsError,
      RuntimeContext
    >
  >
> {}

export const GetConnection = Binding.Service<GetConnection>("GCP.BigQueryConnection.GetConnection");

/**
 * HTTP implementation of {@link GetConnection}.
 *
 * @layer
 * @provides GCP.BigQueryConnection.GetConnection
 */
export const GetConnectionHttp = Layer.effect(
  GetConnection,
  makeConnectionHttpBinding({
    tag: "GCP.BigQueryConnection.GetConnection",
    iam: {
      role: "roles/bigquery.connectionUser",
      on: "bigqueryconnection.connection",
    },
    operation: bigqueryconnection.getProjectsLocationsConnections,
  }),
);
