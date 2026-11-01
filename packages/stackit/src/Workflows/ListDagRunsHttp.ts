import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { ListDagRuns, type ListDagRunsRequest } from "./ListDagRuns.ts";

/**
 * HTTP implementation of {@link ListDagRuns}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.ListDagRuns
 */
export const ListDagRunsHttp = Layer.succeed(
  ListDagRuns,
  makeAirflowBinding((call) => (request: ListDagRunsRequest) => call(rest.listDagRuns, request)),
);
