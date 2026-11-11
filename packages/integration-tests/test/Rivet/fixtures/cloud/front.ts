/** The HTTP front of the Rivet Cloud suite: a Lambda calling the counter and a stream through the cluster's gateway. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export default class Front extends Lambda.Function<Front>()(
  "RivetCloudFront",
  // A stream's first request wakes its actor on the Services node, a round
  // trip or two to Rivet Cloud: more than Lambda's default 3 seconds.
  { main: import.meta.url, functionUrl: true, timeout: Duration.seconds(30) },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
