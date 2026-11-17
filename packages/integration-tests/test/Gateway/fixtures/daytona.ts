import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import { app, WebFunctionGateway } from "../conformance/app.ts";

/**
 * The conformance program in a Daytona sandbox. Its gateway is a Lambda Web
 * Function: below Tier 3 a Daytona sandbox cannot reach workers.dev.
 */
export default class GatewayedDaytona extends Daytona.Sandbox<GatewayedDaytona>()(
  "GatewayedDaytona",
  { main: import.meta.url, port: 3000, public: true },
  app.pipe(Effect.provide(WebFunctionGateway)),
) {}
