import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Output from "alchemy-effect/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ServerInstance from "./src/ServerInstance.ts";
import QueuePollerInstance from "./src/QueuePollerInstance.ts";

const aws = AWS.providers().pipe(Layer.provide(AWS.DefaultStageConfig));

export default Effect.gen(function* () {
  const serverInstance = yield* ServerInstance;
  const workerInstance = yield* QueuePollerInstance;

  return {
    publicIp: serverInstance.publicIpAddress,
    url: Output.interpolate`http://${serverInstance.publicIpAddress}:3000`,
    enqueueExample: Output.interpolate`http://${serverInstance.publicIpAddress}:3000/enqueue?message=hello`,
    workerPrivateIp: workerInstance.privateIpAddress,
  };
}).pipe(Stack.make("AwsEc2Example", aws));
