import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { app, FlyGateway } from "../conformance/app.ts";

/** The conformance program in a Boat sandbox, with a Fly Service gateway. */
export default class FlyGatewayedBoat extends Boat.Sandbox<FlyGatewayedBoat>()(
  "FlyGatewayedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  app.pipe(Effect.provide(FlyGateway)),
) {}
