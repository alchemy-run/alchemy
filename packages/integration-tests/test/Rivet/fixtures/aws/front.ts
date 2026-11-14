/** The HTTP front of the AWS conformance suite: a Lambda calling the counter and a stream through the gateway. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export default class Front extends Lambda.Function<Front>()(
  "RivetAwsFront",
  { main: import.meta.url, functionUrl: true },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
