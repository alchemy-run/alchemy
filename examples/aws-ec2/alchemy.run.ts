import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Output from "alchemy-effect/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ServerInstance from "./src/ServerInstance.ts";

const aws = AWS.providers().pipe(Layer.provide(AWS.DefaultStageConfig));

export default Effect.gen(function* () {
  const instance = yield* ServerInstance;

  return {
    instanceId: instance.instanceId,
    publicIpAddress: instance.publicIpAddress,
    instanceUrl: Output.interpolate`http://${instance.publicIpAddress}:3000`,
    enqueueExample: Output.interpolate`http://${instance.publicIpAddress}:3000/enqueue?message=hello`,
  };
}).pipe(Stack.make("AwsEc2Example", aws));
