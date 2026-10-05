import * as Layer from "effect/Layer";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import {
  ClusterPrivateEndpoint,
  ClusterPrivateEndpointProvider,
} from "./ClusterPrivateEndpoint.ts";
import { Function, FunctionProvider } from "./Function.ts";
import { Input, InputProvider } from "./Input.ts";
import { Output, OutputProvider } from "./Output.ts";
import { StreamingJob, StreamingJobProvider } from "./StreamingJob.ts";
import { Transformation, TransformationProvider } from "./Transformation.ts";

export const resources = [
  Cluster,
  ClusterPrivateEndpoint,
  Function,
  Input,
  Output,
  StreamingJob,
  Transformation,
];
export const layers = () =>
  Layer.mergeAll(
    ClusterProvider(),
    ClusterPrivateEndpointProvider(),
    FunctionProvider(),
    InputProvider(),
    OutputProvider(),
    StreamingJobProvider(),
    TransformationProvider(),
  );
