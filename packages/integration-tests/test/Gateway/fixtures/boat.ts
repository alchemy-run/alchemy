import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../conformance/app.ts";

/** The conformance program in a Boat sandbox. */
export default class GatewayedBoat extends Boat.Sandbox<GatewayedBoat>()(
  "GatewayedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  app.pipe(Effect.provide(WorkerGateway)),
) {}
