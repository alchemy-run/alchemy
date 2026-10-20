import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import HarnessBoxLive from "./box.runtime.ts";
import HarnessGatewayWorker from "./gateway-worker.ts";
import { HarnessGateway } from "./gateway.ts";
import HarnessWorker from "./worker.ts";

export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "HarnessStack",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* HarnessWorker;
    yield* HarnessGatewayWorker;
    return { url: worker.url.as<string>() };
  }).pipe(
    Effect.provide(Layer.mergeAll(HarnessBoxLive, HarnessGateway.host(HarnessGatewayWorker))),
  ),
);
