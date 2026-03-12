import { AWS } from "alchemy-effect";
import * as Http from "alchemy-effect/Http";
import * as Process from "alchemy-effect/Process";
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
    subnetId: network.publicSubnetId,
    securityGroupIds: network.securityGroupIds,
    associatePublicIpAddress: true,
    port: 3000,
    env: {
      QUEUE_URL: queue.queueUrl,
    },
    roleManagedPolicyArns: ["arn:aws:iam::aws:policy/AmazonSQSFullAccess"],
  };
}).pipe(
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(
        NetworkLive,
        Process.SQSQueueEventSource,
        AWS.EC2.HttpServer,
      ),
      Layer.mergeAll(
        AWS.SQS.DeleteMessageBatchLive,
        AWS.SQS.ReceiveMessageLive,
        AWS.SQS.SendMessageLive,
      ),
    ),
  ),
  AWS.EC2.Instance("ServerInstance"),
);

export default ServerInstance;
