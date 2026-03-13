import { AWS } from "alchemy-effect";
import * as Http from "alchemy-effect/Http";
import { SQSQueueEventSource } from "alchemy-effect/Process/SQSQueueEventSource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServer } from "./HttpServer.ts";
import { Network, NetworkLive } from "./Network.ts";

const ServerInstance = Effect.gen(function* () {
  const imageId = yield* AWS.EC2.amazonLinux();
  const network = yield* Network;
  const queue = yield* AWS.SQS.Queue("JobsQueue", {
    receiveMessageWaitTimeSeconds: 20,
    visibilityTimeout: 60,
  });

  const server = yield* HttpServer(queue);

  yield* Http.serve(server);

  yield* AWS.SQS.messages(queue).subscribe((stream) =>
    stream.pipe(Stream.mapEffect(Effect.logInfo), Stream.runDrain),
  );

  return {
    main: import.meta.path,
    imageId,
    instanceType: "t3.small",
    securityGroupIds: [network.appSecurityGroupId],
    port: 3000,
  };
}).pipe(
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(NetworkLive, SQSQueueEventSource, AWS.EC2.HttpServer),
      Layer.mergeAll(
        AWS.SQS.DeleteMessageBatchLive,
        AWS.SQS.ReceiveMessageLive,
        AWS.SQS.SendMessageLive,
      ),
    ),
  ),
  AWS.AutoScaling.LaunchTemplate("ServerInstance"),
);

export default ServerInstance;
