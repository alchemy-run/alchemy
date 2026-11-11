/** The HTTP front of the Compute Engine suite: a public Cloud Run service calling the counter and a stream. */
import * as GCP from "@alchemy.run/gcp";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export default class Front extends GCP.Run.Service<Front>()(
  "RivetGcpFront",
  { main: import.meta.url, invokerIamDisabled: true },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
