import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as Lambda from "alchemy/AWS/Lambda";
import * as S3 from "alchemy/AWS/S3";
import * as SQS from "alchemy/AWS/SQS";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MARKER } from "./marker.ts";

/**
 * Kitchen-sink dev-mode Lambda: one Function owning an S3 bucket, a
 * DynamoDB table, and an SQS queue, exercising each runtime binding over
 * HTTP routes so `alchemy dev` can be driven end-to-end from a test.
 *
 * Routes:
 *   - GET  /                  → marker + env (Config-provided MY_VARIABLE)
 *   - GET  /s3                → PutObject/GetObject roundtrip
 *   - GET  /dynamo            → PutItem/GetItem roundtrip
 *   - POST /queue/send        → SendMessage over the binding
 *   - GET  /queue/messages    → reads what the queue consumer recorded
 *
 * The queue consumer (`consumeQueueMessages`) runs on this same Function —
 * the local broker (floci's event-source-mapping poller) invokes it with
 * SQS batches, and it records each message into the table so the produce →
 * consume path is observable over HTTP.
 */
export default class ApiFunction extends Lambda.Function<ApiFunction>()(
  "ApiFunction",
  {
    main: import.meta.url,
    functionUrl: true,
    env: { MY_VARIABLE: "my-variable-abc123" },
  },
  Effect.gen(function* () {
    // `/s3` writes into the bucket, so destroy must empty it first.
    const bucket = yield* S3.Bucket("DevBucket", { forceDestroy: true });
    const table = yield* DynamoDB.Table("MessagesTable", {
      partitionKey: "id",
      attributes: { id: "S" },
    });
    const queue = yield* SQS.Queue("DevQueue");

    const getObject = yield* S3.GetObject(bucket);
    const putObject = yield* S3.PutObject(bucket);
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const sendMessage = yield* SQS.SendMessage(queue);

    // Consume produced messages and record them into the table so the
    // test can observe the produce → deliver → consume roundtrip.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.mapEffect((record) => {
          const parsed = JSON.parse(record.body) as { id: string };
          return putItem({
            Item: {
              id: { S: `msg:${parsed.id}` },
              body: { S: record.body },
            },
          });
        }),
        Stream.runDrain,
        Effect.orDie,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (url.pathname === "/") {
          const variable = yield* Config.string("MY_VARIABLE");
          return yield* HttpServerResponse.json({ marker: MARKER, variable });
        }

        if (url.pathname === "/s3") {
          yield* putObject({ Key: "hello.txt", Body: "hello from s3" });
          const object = yield* getObject({ Key: "hello.txt" });
          const text = yield* (object.Body?.pipe(
            Stream.decodeText,
            Stream.mkString,
          ) ?? Effect.succeed(""));
          return yield* HttpServerResponse.json({ text });
        }

        if (url.pathname === "/dynamo") {
          yield* putItem({
            Item: {
              id: { S: "hello" },
              content: { S: "hello from dynamo" },
            },
          });
          const item = yield* getItem({ Key: { id: { S: "hello" } } });
          return yield* HttpServerResponse.json({
            text: item.Item?.content?.S ?? null,
          });
        }

        if (url.pathname === "/queue/send" && request.method === "POST") {
          const body = yield* request.text;
          yield* sendMessage({ MessageBody: body });
          return yield* HttpServerResponse.json({ sent: true });
        }

        if (url.pathname === "/queue/messages") {
          const id = url.searchParams.get("id") ?? "";
          const item = yield* getItem({ Key: { id: { S: `msg:${id}` } } });
          return yield* HttpServerResponse.json({
            body: item.Item?.body?.S ?? null,
          });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.QueueEventSource,
        S3.GetObjectHttp,
        S3.PutObjectHttp,
        DynamoDB.GetItemHttp,
        DynamoDB.PutItemHttp,
        SQS.SendMessageHttp,
      ),
    ),
  ),
) {}
