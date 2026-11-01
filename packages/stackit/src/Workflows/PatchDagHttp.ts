import * as rest from "@distilled.cloud/stackit/workflows_airflow";
import * as Layer from "effect/Layer";
import { makeAirflowBinding } from "./BindingHttp.ts";
import { PatchDag, type PatchDagRequest } from "./PatchDag.ts";

/**
 * HTTP implementation of {@link PatchDag}, on Airflow's REST API.
 *
 * @layer
 * @provides Stackit.Workflows.PatchDag
 */
export const PatchDagHttp = Layer.succeed(
  PatchDag,
  makeAirflowBinding((call) => (request: PatchDagRequest) => call(rest.patchDag, request)),
);
