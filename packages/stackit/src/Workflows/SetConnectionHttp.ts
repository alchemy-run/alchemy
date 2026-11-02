import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { SetConnection, type SetConnectionRequest } from "./SetConnection.ts";

/**
 * HTTP implementation of {@link SetConnection}, on Airflow's REST API. Airflow has no upsert for a
 * single connection: this updates, creates on a 404, and updates again if another writer's create
 * got there first.
 *
 * @layer
 * @provides Stackit.Workflows.SetConnection
 */
export const SetConnectionHttp = Layer.succeed(
  SetConnection,
  makeAirflowBinding((call) => (request: SetConnectionRequest) => {
    const update = call(rest.patchConnection, {
      ...request,
      connection_key: request.connection_id,
    });
    return update.pipe(
      Effect.catchTag("NotFound", () => call(rest.createConnection, request)),
      Effect.catchTag("Conflict", () => update),
    );
  }),
);
