/** The HTTP front of the Railway conformance suite: a Railway Service calling the counter and a stream. */
import * as Railway from "@alchemy.run/railway";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export const FrontProject = Railway.Project("RivetRailwayFrontProject");

export default class Front extends Railway.Service<Front>()(
  "RivetRailwayFront",
  { project: FrontProject, main: import.meta.url },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
