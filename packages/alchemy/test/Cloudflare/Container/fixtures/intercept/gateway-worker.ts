import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
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
