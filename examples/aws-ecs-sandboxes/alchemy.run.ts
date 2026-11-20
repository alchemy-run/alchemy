// alchemy.run.ts
import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

/**
 * One sandbox per user on ECS. Each sandbox is an ECS task in its own Nitro
 * Sandbox, which the Api Function starts while it runs. Deploying creates the
 * network, the cluster, the capacity provider and the Function; ECS launches
 * an instance when the first sandbox needs one.
 */
export default Alchemy.Stack(
  "AwsEcsSandboxesExample",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.functionUrl };
  }),
);
