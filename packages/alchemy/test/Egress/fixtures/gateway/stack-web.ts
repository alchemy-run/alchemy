import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import ConsumerWorker from "./consumer-worker.ts";
import GatewayWebFunction from "./gateway-web.ts";
import { TestGateway } from "./gateway.ts";

export const providers = Layer.mergeAll(
  Cloudflare.providers(),
  AWS.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

/** The consumer Worker, with {@link TestGateway} hosted on a Lambda Web Function. */
export default Alchemy.Stack(
  "EgressGatewayWebStack",
  { providers, state },
  Effect.gen(function* () {
    const consumer = yield* ConsumerWorker;
    const gateway = yield* GatewayWebFunction;
    return { consumer: consumer.url.as<string>(), gateway: gateway.url.as<string>() };
  }).pipe(Effect.provide(TestGateway.host(GatewayWebFunction))),
);
