import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as sqs from "@distilled.cloud/aws/sqs";
import { NodeServices } from "@effect/platform-node";
import * as AWS from "alchemy-effect/AWS";
import * as Http from "alchemy-effect/Http";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const runtime = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer).pipe(
  Layer.provideMerge(Credentials.fromEnv()),
  Layer.provideMerge(Region.fromEnv()),
  Layer.provideMerge(
    Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
);

export const ApiTask = (queue: Pick<AWS.SQS.Queue, "queueUrl">) =>
  Effect.gen(function* () {
    yield* Http.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/") {
          return yield* HttpServerResponse.json({
            ok: true,
            routes: ["GET /", "GET /enqueue?message=hello"],
          });
        }

        if (request.method === "GET" && url.pathname === "/enqueue") {
          const queueUrl = yield* Config.string("QUEUE_URL");
          const message = url.searchParams.get("message") ?? "hello from ECS";
          const body = JSON.stringify({
            message,
            enqueuedAt: new Date().toISOString(),
          });

          const result = yield* sqs.sendMessage({
            QueueUrl: queueUrl,
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
        Effect.provide(runtime),
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal server error", { status: 500 }),
          ),
        ),
      ),
    );

    return {
      main: import.meta.path,
      cpu: 512,
      memory: 1024,
      port: 3000,
      env: {
        QUEUE_URL: queue.queueUrl,
      },
      taskRoleManagedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonSQSFullAccess",
      ],
      docker: {
        instructions: [["workdir", "/app"] as const],
      },
    };
  }).pipe(Effect.provide(AWS.ECS.HttpServer), AWS.ECS.Task("ApiTask"));
