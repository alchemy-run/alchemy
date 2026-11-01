import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { stackitTags } from "../helpers.ts";
import ObjectStorageBindingsWorker, { Data } from "./fixtures/worker.ts";
import { s3Propagation, withOutOfBandS3 } from "./s3.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitObjectStorageBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ObjectStorageBindingsWorker;
    const data = yield* Data;
    return {
      url: worker.url.as<string>(),
      bucketName: data.bucketName,
      projectId: data.projectId,
      region: data.region,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const READ_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"];

interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Principal?: { readonly AWS: string };
  readonly Action?: readonly string[];
  readonly NotAction?: readonly string[];
}

describe(
  "STACKIT Object Storage bindings on a Cloudflare Worker",
  { tags: [...stackitTags("objectstorage", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL and the host's keys take a while to propagate:
    // retry until the route answers `ok`, then report the last answer.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    const target = Effect.gen(function* () {
      const { projectId, region, bucketName } = yield* stack;
      return { projectId: projectId!, region: region!, bucketName: bucketName! };
    });

    /** Put an object with a key of the project's `default` group. */
    const seed = (key: string, body: string) =>
      Effect.gen(function* () {
        const { bucketName, ...location } = yield* target;
        yield* withOutOfBandS3(
          location,
          s3.putObject({ Bucket: bucketName, Key: key, Body: body }).pipe(
            Effect.retry({
              while: (error) => error._tag === "InvalidAccessKeyId",
              ...s3Propagation,
            }),
          ),
        );
      });

    /** An object's text, or `undefined` when it is missing. */
    const observe = (key: string) =>
      Effect.gen(function* () {
        const { bucketName, ...location } = yield* target;
        return yield* withOutOfBandS3(
          location,
          s3.getObject({ Bucket: bucketName, Key: key }).pipe(
            Effect.retry({
              while: (error) => error._tag === "InvalidAccessKeyId",
              ...s3Propagation,
            }),
            Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))),
            Effect.catchTag("NoSuchKey", () => Effect.undefined),
          ),
        );
      });

    describe("ReadBucket", () => {
      test.provider(
        "gets, heads and lists objects",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("read/hello.txt", "hello");

            const got = yield* call("/read/get", { key: "read/hello.txt" });
            expectOk(got);
            expect(got.result).toBe("hello");

            const head = yield* call("/read/head", { key: "read/hello.txt" });
            expectOk(head);
            expect(head.result.contentLength).toBe(5);

            const listed = yield* call("/read/list", { key: "read/" });
            expectOk(listed);
            expect(listed.result).toContain("read/hello.txt");
          }),
        { timeout: 240_000 },
      );

      test.provider(
        "the bucket policy limits the host's read group to the read actions",
        (_stack) =>
          Effect.gen(function* () {
            // Deployed before this test runs; the route proves the key works.
            expectOk(yield* call("/read/list", { key: "" }));
            const { bucketName, ...location } = yield* target;

            const policy = yield* withOutOfBandS3(
              location,
              s3.getBucketPolicy({ Bucket: bucketName }).pipe(
                Effect.retry({
                  while: (error) => error._tag === "InvalidAccessKeyId",
                  ...s3Propagation,
                }),
              ),
            );
            const { Statement: statements } = JSON.parse(policy.Policy!) as {
              Statement: readonly Statement[];
            };
            const deny = statements.find(
              (statement) =>
                statement.Effect === "Deny" &&
                JSON.stringify(statement.NotAction) === JSON.stringify(READ_ACTIONS),
            );
            expect(deny?.Principal?.AWS).toMatch(/group\/credentials-group-/);

            // A new key in that group reads, and is refused a write.
            const { credentialsGroups } = yield* objectStorage.listCredentialsGroups(location);
            const group = credentialsGroups.find(
              (candidate) => candidate.urn === deny?.Principal?.AWS,
            );
            expect(group).toBeDefined();
            const refused = yield* withOutOfBandS3(
              { ...location, credentialsGroupId: group!.credentialsGroupId },
              s3.putObject({ Bucket: bucketName, Key: "read/denied.txt", Body: "no" }).pipe(
                Effect.as("written" as const),
                Effect.retry({
                  while: (error) => error._tag === "InvalidAccessKeyId",
                  ...s3Propagation,
                }),
                Effect.catch((error) => Effect.succeed(error._tag)),
              ),
            );
            expect(refused).not.toBe("written");
            expect(yield* observe("read/denied.txt")).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("WriteBucket", () => {
      test.provider(
        "puts and deletes objects",
        (_stack) =>
          Effect.gen(function* () {
            const put = yield* call("/write/put", { key: "write/one.txt", body: "one" });
            expectOk(put);
            expect(yield* observe("write/one.txt")).toBe("one");

            const deleted = yield* call("/write/delete", { key: "write/one.txt" });
            expectOk(deleted);
            expect(yield* observe("write/one.txt")).toBeUndefined();

            yield* seed("write/two.txt", "two");
            const deletedMany = yield* call("/write/delete-many", { key: "write/two.txt" });
            expectOk(deletedMany);
            expect(yield* observe("write/two.txt")).toBeUndefined();
          }),
        { timeout: 240_000 },
      );

      test.provider(
        "completes and aborts multipart uploads",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write/multipart", {
              key: "write/parts.txt",
              body: "assembled",
            });
            expectOk(body);
            expect(body.result.listedParts).toBe(1);
            expect(yield* observe("write/parts.txt")).toBe("assembled");

            const aborted = yield* call("/write/multipart-abort", { key: "write/aborted.txt" });
            expectOk(aborted);
            expect(yield* observe("write/aborted.txt")).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadWriteBucket", () => {
      test.provider(
        "writes an object and reads it back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write/round-trip", {
              key: "both/round-trip.txt",
              body: "round trip",
            });
            expectOk(body);
            expect(body.result).toBe("round trip");
            expect(yield* observe("both/round-trip.txt")).toBe("round trip");
          }),
        { timeout: 240_000 },
      );
    });

    describe("PresignGetObject", () => {
      test.provider(
        "mints a URL that downloads without credentials",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("presign/get.txt", "presigned");
            const minted = yield* call("/presign-get", { key: "presign/get.txt" });
            expectOk(minted);

            const text = yield* HttpClient.get(minted.result as string).pipe(
              Effect.flatMap(
                (response): Effect.Effect<string, HttpClientError.HttpClientError | number> =>
                  response.status === 200 ? response.text : Effect.fail(response.status),
              ),
              Effect.retry(s3Propagation),
            );
            expect(text).toBe("presigned");
          }),
        { timeout: 240_000 },
      );
    });

    describe("PresignPutObject", () => {
      test.provider(
        "mints a URL that uploads without credentials",
        (_stack) =>
          Effect.gen(function* () {
            const minted = yield* call("/presign-put", { key: "presign/put.txt" });
            expectOk(minted);

            const status = yield* HttpClient.execute(
              HttpClientRequest.put(minted.result as string).pipe(
                HttpClientRequest.bodyText("uploaded"),
              ),
            ).pipe(
              Effect.flatMap((response) =>
                response.status === 200 ? Effect.succeed(200) : Effect.fail(response.status),
              ),
              Effect.retry(s3Propagation),
            );
            expect(status).toBe(200);
            expect(yield* observe("presign/put.txt")).toBe("uploaded");
          }),
        { timeout: 240_000 },
      );
    });
  },
);
