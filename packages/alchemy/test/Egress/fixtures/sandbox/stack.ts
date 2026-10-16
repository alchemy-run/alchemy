import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import EgressSandboxLive from "./box.runtime.ts";
import GatewayAWorker from "./gateway-a.ts";
import GatewayBWorker from "./gateway-b.ts";
import { GatewayA, GatewayB } from "./gateways.ts";
import EgressSandboxWorker from "./worker.ts";

export const providers = Layer.mergeAll(
  Cloudflare.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "EgressSandboxStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* EgressSandboxWorker;
    return { url: worker.url.as<string>() };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EgressSandboxLive,
        GatewayA.host(GatewayAWorker),
        GatewayB.host(GatewayBWorker),
      ),
    ),
  ),
);
