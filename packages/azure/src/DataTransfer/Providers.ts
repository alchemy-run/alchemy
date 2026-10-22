import * as Layer from "effect/Layer";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Flow, FlowProvider } from "./Flow.ts";
import { Pipeline, PipelineProvider } from "./Pipeline.ts";

export const resources = [Connection, Flow, Pipeline];
export const layers = () =>
  Layer.mergeAll(ConnectionProvider(), FlowProvider(), PipelineProvider());
