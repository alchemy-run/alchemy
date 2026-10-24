import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
