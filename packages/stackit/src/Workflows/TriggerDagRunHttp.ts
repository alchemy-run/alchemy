import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { TriggerDagRun, type TriggerDagRunRequest } from "./TriggerDagRun.ts";

/**
 * HTTP implementation of {@link TriggerDagRun}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.TriggerDagRun
 */
export const TriggerDagRunHttp = Layer.succeed(
  TriggerDagRun,
  makeAirflowBinding(
    (call) => (request: TriggerDagRunRequest) =>
      call(rest.triggerDagRun, { ...request, logical_date: request.logical_date ?? null }),
  ),
);
