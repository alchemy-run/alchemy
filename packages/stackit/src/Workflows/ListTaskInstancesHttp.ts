import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { ListTaskInstances, type ListTaskInstancesRequest } from "./ListTaskInstances.ts";

/**
 * HTTP implementation of {@link ListTaskInstances}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.ListTaskInstances
 */
export const ListTaskInstancesHttp = Layer.succeed(
  ListTaskInstances,
  makeAirflowBinding(
    (call) => (request: ListTaskInstancesRequest) => call(rest.listTaskInstances, request),
  ),
);
