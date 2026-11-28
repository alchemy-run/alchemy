import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../conformance/app.ts";

/** The conformance program in an Archil sandbox. */
export default class GatewayedArchil extends Archil.Sandbox<GatewayedArchil>()(
  "GatewayedArchil",
  { main: import.meta.url, port: 3000, idleTtlSeconds: 300 },
  app.pipe(Effect.provide(WorkerGateway)),
) {}
