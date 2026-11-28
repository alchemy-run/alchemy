import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../../conformance/app.ts";

/** The conformance program in a Cloudflare Container. */
export class GatewayedContainer extends Cloudflare.Container<GatewayedContainer, {}>()(
  "GatewayedContainer",
) {}

export default GatewayedContainer.make(
  { main: import.meta.url, image: "oven/bun:latest" },
  app.pipe(Effect.provide(WorkerGateway)),
);
