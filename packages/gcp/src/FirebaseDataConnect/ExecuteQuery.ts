import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConnectorHttpBinding } from "./BindingHttp.ts";
import type { ServicesConnector } from "./ServicesConnector.ts";

export interface ExecuteQueryRequest extends Omit<
  firebasedataconnect.ExecuteQueryProjectsLocationsServicesConnectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Data Connect `connectors.executeQuery`.
 *
 * Runs a named query defined on a {@link ServicesConnector}. Provide
 * {@link ExecuteQueryHttp}.
 *
 * ### Executing a Query
 * **Example:** Named connector query
 * ```typescript
 * const executeQuery = yield* GCP.FirebaseDataConnect.ExecuteQuery(
 *   connector,
 * );
 * const result = yield* executeQuery({
 *   body: { operationName: "ListNotes" },
 * });
 * ```
 *
 * @binding
 * @category FirebaseDataConnect
 */
export interface ExecuteQuery extends Binding.Service<
  ExecuteQuery,
  "GCP.FirebaseDataConnect.ExecuteQuery",
  (
    connector: ServicesConnector,
  ) => Effect.Effect<
    (
      request: ExecuteQueryRequest,
    ) => Effect.Effect<
      firebasedataconnect.ExecuteQueryResponse,
      firebasedataconnect.ExecuteQueryProjectsLocationsServicesConnectorsError,
      RuntimeContext
    >
  >
> {}

export const ExecuteQuery = Binding.Service<ExecuteQuery>("GCP.FirebaseDataConnect.ExecuteQuery");

/**
 * HTTP implementation of {@link ExecuteQuery}.
 *
 * @layer
 * @provides GCP.FirebaseDataConnect.ExecuteQuery
 */
export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeConnectorHttpBinding({
    tag: "GCP.FirebaseDataConnect.ExecuteQuery",
    iam: { role: "roles/firebasedataconnect.dataViewer" },
    operation: firebasedataconnect.executeQueryProjectsLocationsServicesConnectors,
  }),
);
