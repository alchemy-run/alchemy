import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../conformance/app.ts";

/** The conformance program in an E2B sandbox. */
export default class GatewayedE2B extends E2B.Template<GatewayedE2B>()(
  "GatewayedE2B",
  { main: import.meta.url, port: 3000 },
  app.pipe(Effect.provide(WorkerGateway)),
) {}
