import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { SetVariable, type SetVariableRequest } from "./SetVariable.ts";

/**
 * HTTP implementation of {@link SetVariable}, on Airflow's REST API. Airflow has no upsert for a
 * single variable: this updates, creates on a 404, and updates again if another writer's create
 * got there first.
 *
 * @layer
 * @provides Stackit.Workflows.SetVariable
 */
export const SetVariableHttp = Layer.succeed(
  SetVariable,
  makeAirflowBinding((call) => (request: SetVariableRequest) => {
    const update = call(rest.patchVariable, { ...request, variable_key: request.key });
    return update.pipe(
      Effect.catchTag("NotFound", () => call(rest.createVariable, request)),
      Effect.catchTag("Conflict", () => update),
    );
  }),
);
