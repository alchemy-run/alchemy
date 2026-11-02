import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { GetDagRun, type GetDagRunRequest } from "./GetDagRun.ts";

/**
 * HTTP implementation of {@link GetDagRun}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.GetDagRun
 */
export const GetDagRunHttp = Layer.succeed(
  GetDagRun,
  makeAirflowBinding((call) => (request: GetDagRunRequest) => call(rest.getDagRun, request)),
);
