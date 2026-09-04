import * as AWS from "alchemy/AWS";
import { SQSQueueEventSource } from "alchemy/Server/SQSQueueEventSource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Server extends AWS.EC2.Instance<Server>()(
  "ServerInstance",
  Effect.gen(function* () {
    // Props are re-executed inside the deployed bundle. Yield the network
    // resources directly so runtime sees references, not a Context.Service
    // that would have to be provided (and would try to create a VPC).
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 1,
    });
    const appSecurityGroup = yield* AWS.EC2.SecurityGroup("AppSecurityGroup", {
      vpcId: network.vpcId,
      description: "Security group for the EC2 application instance",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    });

    return {
      main: import.meta.url,
      imageId: AWS.EC2.amazonLinux2023(),
      instanceType: "t3.small",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [appSecurityGroup.groupId],
      associatePublicIpAddress: true,
      port: 3000,
    };
  }),
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("JobsQueue", {
      receiveMessageWaitTime: "20 seconds",
      visibilityTimeout: "60 seconds",
    });

    yield* AWS.SQS.consumeQueueMessages(queue, (stream) =>
      stream.pipe(Stream.mapEffect(Effect.logInfo), Stream.runDrain),
    );

    const sendMessage = yield* AWS.SQS.SendMessage(queue);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return yield* HttpServerResponse.json({
            ok: true,
            routes: ["GET /", "GET /enqueue?message=hello"],
          });
        }

        if (request.method === "GET" && url.pathname === "/enqueue") {
          const message = url.searchParams.get("message") ?? "hello from EC2";
          const body = JSON.stringify({
            message,
            enqueuedAt: new Date().toISOString(),
          });

          const result = yield* sendMessage({
            MessageBody: body,
          });

          return yield* HttpServerResponse.json({
            ok: true,
            message,
            messageId: result.MessageId,
          });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal server error", { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        SQSQueueEventSource,
        Layer.mergeAll(
          AWS.SQS.DeleteMessageBatchHttp,
          AWS.SQS.ReceiveMessageHttp,
          AWS.SQS.SendMessageHttp,
        ),
      ),
    ),
  ),
) {}
