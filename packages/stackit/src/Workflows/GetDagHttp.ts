import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { GetDag, type GetDagRequest } from "./GetDag.ts";

/**
 * HTTP implementation of {@link GetDag}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.GetDag
 */
export const GetDagHttp = Layer.succeed(
  GetDag,
  makeAirflowBinding((call) => (request: GetDagRequest) => call(rest.getDag, request)),
);
