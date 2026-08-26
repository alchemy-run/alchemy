import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makePipelineHttpBinding } from "./BindingHttp.ts";
import { StopPipeline } from "./StopPipeline.ts";

/**
 * HTTP implementation of {@link StopPipeline}.
 *
 * @layer
 * @provides GCP.Datapipelines.StopPipeline
 */
export const StopPipelineHttp: Layer.Layer<
  StopPipeline,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  StopPipeline,
  makePipelineHttpBinding<
    datapipelines.StopProjectsLocationsPipelinesRequest,
    datapipelines.GoogleCloudDatapipelinesV1Pipeline,
    datapipelines.StopProjectsLocationsPipelinesError
  >({
    tag: "GCP.Datapipelines.StopPipeline",
    operation: datapipelines.stopProjectsLocationsPipelines,
  }),
);
