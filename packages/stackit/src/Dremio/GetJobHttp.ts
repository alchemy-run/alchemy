import * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Layer from "effect/Layer";
import { makeRestBinding } from "./BindingHttp.ts";
import { GetJob, type GetJobRequest } from "./GetJob.ts";

/**
 * HTTP implementation of {@link GetJob}, on Dremio's REST API.
 *
 * @layer
 * @provides Stackit.Dremio.GetJob
 */
export const GetJobHttp = Layer.succeed(
  GetJob,
  makeRestBinding((call) => (request: GetJobRequest) => call(rest.getJob, request)),
);
