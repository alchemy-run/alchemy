/** The HTTP front of the Fly conformance suite: a public Fly Service calling the counter and a stream. */
import * as Fly from "@alchemy.run/fly";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export default class Front extends Fly.Service<Front>()(
  "RivetFlyFront",
  { main: import.meta.url },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
