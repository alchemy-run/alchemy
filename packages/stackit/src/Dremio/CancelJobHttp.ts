import * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Layer from "effect/Layer";
import { makeRestBinding } from "./BindingHttp.ts";
import { CancelJob, type CancelJobRequest } from "./CancelJob.ts";

/**
 * HTTP implementation of {@link CancelJob}, on Dremio's REST API.
 *
 * @layer
 * @provides Stackit.Dremio.CancelJob
 */
export const CancelJobHttp = Layer.succeed(
  CancelJob,
  makeRestBinding((call) => (request: CancelJobRequest) => call(rest.cancelJob, request)),
);
