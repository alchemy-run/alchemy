import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as GitHub from "@/GitHub/index.ts";
import * as Alchemy from "@/index.ts";
import LambdaGatewayConsumer from "./consumer-worker.ts";
import LambdaGatewayFunction from "./gateway-function.ts";
import { LambdaTestGateway } from "./gateway.ts";

export const providers = Layer.mergeAll(
  AWS.providers(),
  Cloudflare.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.inMemoryState();

/** A Cloudflare Worker that mints grants from a gateway hosted on AWS Lambda. */
export default Alchemy.Stack(
  "EgressLambdaGatewayStack",
  { providers, state },
  Effect.gen(function* () {
    const consumer = yield* LambdaGatewayConsumer;
    const gateway = yield* LambdaGatewayFunction;
    return {
      consumer: consumer.url.as<string>(),
      gateway: gateway.functionUrl.as<string>(),
      functionArn: gateway.functionArn.as<string>(),
    };
  }).pipe(Effect.provide(LambdaTestGateway.host(LambdaGatewayFunction))),
);
