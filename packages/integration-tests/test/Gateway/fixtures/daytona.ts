import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import { app, InvokeGateway } from "../conformance/app.ts";

/**
 * The conformance program in a Daytona sandbox. Below Tier 3 a Daytona
 * sandbox reaches AWS's API endpoints but neither a Worker's nor a Web
 * Function's url, so its gateway is a Lambda Function it invokes.
 */
export default class GatewayedDaytona extends Daytona.Sandbox<GatewayedDaytona>()(
  "GatewayedDaytona",
  { main: import.meta.url, port: 3000, public: true },
  app.pipe(Effect.provide(InvokeGateway)),
) {}
