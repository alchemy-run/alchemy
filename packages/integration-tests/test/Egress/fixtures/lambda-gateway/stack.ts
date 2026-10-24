import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
