/**
 * DynamoDB `*Http` bindings on a Cloudflare Worker host: the Worker gets an
 * IAM user, access key and least-privilege role, and signs each request with
 * the assumed role in the table's region.
 */
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LinksWorker, { LinksTable } from "./fixtures/links-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
});

class NotReady extends Data.TaggedError("NotReady")<{
  readonly status: number;
  readonly body: string;
}> {}

class TableStillExists extends Data.TaggedError("TableStillExists") {}

// A fresh workers.dev URL, a fresh IAM access key and a fresh role trust
// policy all take seconds to propagate: retry non-2xx answers for ~90s.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ status: response.status, body })),
            ),
          ),
    ),
    Effect.tapError((error) =>
      Effect.logInfo(
        `DynamoDB Worker host: not ready (${error._tag === "NotReady" ? `${error.status} ${error.body.slice(0, 300)}` : error._tag})`,
      ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

describe(
  "AWS.DynamoDB bindings on a Cloudflare Worker",
  {
    tags: [
      "provider:aws",
      "provider:aws:dynamodb",
      "provider:aws:iam",
      "provider:cloudflare",
      "live",
    ],
  },
  () => {
    test.provider(
      "GetItemHttp, PutItemHttp and ScanHttp sign with the Worker's assumed role",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { url, tableName } = yield* stack.deploy(
            Effect.gen(function* () {
              const worker = yield* LinksWorker;
              const table = yield* LinksTable;
              return {
                url: worker.url.as<string>(),
                tableName: table.tableName,
              };
            }),
          );
          expect(url).toBeDefined();

          const put = yield* send(
            HttpClientRequest.put(`${url}/links/alchemy`).pipe(
              HttpClientRequest.bodyText("https://alchemy.run"),
            ),
          );
          expect(yield* put.json).toEqual({
            id: "alchemy",
            url: "https://alchemy.run",
          });

          // Out of band: the item landed in the table.
          const stored = yield* DynamoDB.getItem({
            TableName: tableName,
            Key: { id: { S: "alchemy" } },
            ConsistentRead: true,
          });
          expect(stored.Item?.url?.S).toEqual("https://alchemy.run");

          const got = yield* send(
            HttpClientRequest.get(`${url}/links/alchemy`),
          );
          expect(yield* got.json).toEqual({
            id: "alchemy",
            url: "https://alchemy.run",
          });

          // A second item written out of band shows up in the Worker's scan.
          yield* DynamoDB.putItem({
            TableName: tableName,
            Item: { id: { S: "effect" }, url: { S: "https://effect.website" } },
          });
          const scanned = yield* send(HttpClientRequest.get(`${url}/links`));
          expect(yield* scanned.json).toEqual({ ids: ["alchemy", "effect"] });

          yield* stack.destroy();

          yield* DynamoDB.describeTable({ TableName: tableName }).pipe(
            Effect.flatMap(() => Effect.fail(new TableStillExists())),
            Effect.retry({
              while: (e) => e._tag === "TableStillExists",
              schedule: Schedule.max([
                Schedule.fixed("1 second"),
                Schedule.recurs(30),
              ]),
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      { timeout: 240_000 },
    );
  },
);
