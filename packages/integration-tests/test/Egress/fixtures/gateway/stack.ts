import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ConsumerWorker from "./consumer-worker.ts";
import GatewayWorker from "./gateway-worker.ts";
import { TestGateway } from "./gateway.ts";

export const providers = Layer.mergeAll(
  Cloudflare.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "EgressGatewayStack",
  { providers, state },
  Effect.gen(function* () {
    const consumer = yield* ConsumerWorker;
    const gateway = yield* GatewayWorker;
    return { consumer: consumer.url.as<string>(), gateway: gateway.url.as<string>() };
  }).pipe(Effect.provide(TestGateway.host(GatewayWorker))),
);
