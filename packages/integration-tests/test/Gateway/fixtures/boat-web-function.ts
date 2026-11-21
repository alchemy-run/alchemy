import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { app, WebFunctionGateway } from "../conformance/app.ts";

/** The conformance program in a Boat sandbox, with a Lambda Web Function gateway. */
export default class WebGatewayedBoat extends Boat.Sandbox<WebGatewayedBoat>()(
  "WebGatewayedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  app.pipe(Effect.provide(WebFunctionGateway)),
) {}
