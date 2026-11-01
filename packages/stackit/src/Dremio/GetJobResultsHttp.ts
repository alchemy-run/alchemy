import * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Layer from "effect/Layer";
import { makeRestBinding } from "./BindingHttp.ts";
import { GetJobResults, type GetJobResultsRequest } from "./GetJobResults.ts";

/**
 * HTTP implementation of {@link GetJobResults}, on Dremio's REST API.
 *
 * @layer
 * @provides Stackit.Dremio.GetJobResults
 */
export const GetJobResultsHttp = Layer.succeed(
  GetJobResults,
  makeRestBinding((call) => (request: GetJobResultsRequest) => call(rest.getJobResults, request)),
);
