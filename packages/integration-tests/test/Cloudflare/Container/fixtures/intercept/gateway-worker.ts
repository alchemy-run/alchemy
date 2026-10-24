import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Echo, EchoGateway } from "./gateway.ts";

export default class EchoGatewayWorker extends Cloudflare.Worker<EchoGatewayWorker>()(
  "InterceptEchoGatewayWorker",
  { main: import.meta.url },
  EchoGateway.serve(
    Effect.gen(function* () {
      return { echo: yield* Echo() };
    }),
  ),
) {}
