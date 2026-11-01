import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as functions from "@distilled.cloud/stackit/functions";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The status of a request, once a fresh function answers it. */
const whenServing = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status >= 500 ? Effect.fail(`HTTP ${response.status}`) : Effect.succeed(response),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

/** Run `use` with an S3 key of its own, in the project's default credentials group. */
const withS3 = <A, E, R>(
  target: { readonly projectId: string; readonly region: string },
  use: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    objectStorage.createAccessKey({ projectId: target.projectId, region: target.region }),
    (key) =>
      use.pipe(
        Effect.provide(
          Layer.mergeAll(
            fromCredentials(
              {
                accessKeyId: Redacted.make(key.accessKey),
                secretAccessKey:
                  typeof key.secretAccessKey === "string"
                    ? Redacted.make(key.secretAccessKey)
                    : key.secretAccessKey,
              },
              target.region as RegionName,
            ),
            Endpoint.of(`https://object.storage.${target.region}.onstackit.cloud`),
            FetchHttpClient.layer,
          ),
        ),
      ),
    (key) =>
      objectStorage
        .deleteAccessKey({ projectId: target.projectId, region: target.region, keyId: key.keyId })
        .pipe(Effect.ignore),
  ).pipe(Effect.provide(StackitCloud));

describe("stackit-function", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, functionId, bucketName } = deployed;

      const fn = yield* functions.getFunction({ projectId, functionId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.provide(StackitCloud),
      );
      expect(fn).toEqual("gone");

      const bucket = yield* objectStorage.getBucket({ projectId, region, bucketName }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.provide(StackitCloud),
      );
      expect(bucket).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "serves the health route on the function's URL",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* whenServing(HttpClientRequest.get(`${url}/`));
      expect(response.status).toBe(200);
      expect(yield* response.text).toEqual("ok");
    }),
    { timeout: 300_000 },
  );

  test(
    "the deployed function is active and runs its pinned image",
    Effect.gen(function* () {
      const { projectId, functionId } = yield* stack;
      const { fn, revision } = yield* functions.getFunction({ projectId, functionId }).pipe(
        Effect.flatMap((fn) =>
          functions
            .getRevision({ projectId, functionId, revisionId: fn.current_revision! })
            .pipe(Effect.map((revision) => ({ fn, revision }))),
        ),
        Effect.provide(StackitCloud),
      );
      expect(fn.state).toEqual("ACTIVE");
      expect(revision.oci_reference).toMatch(/@sha256:[a-f0-9]{64}$/);
    }),
    { timeout: 120_000 },
  );

  test(
    "stores, reads, lists and deletes a file in the bucket",
    Effect.gen(function* () {
      const { url, projectId, region, bucketName } = yield* stack;
      const key = "hello.txt";
      const body = "hello from a STACKIT Function";

      // The created access key and the bucket's policy take a moment to apply.
      const put = yield* HttpClient.execute(
        HttpClientRequest.put(`${url}/files/${key}`).pipe(HttpClientRequest.bodyText(body)),
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.succeed(response)
            : Effect.fail(`HTTP ${response.status}`),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(put.status).toBe(204);

      const read = yield* HttpClient.execute(HttpClientRequest.get(`${url}/files/${key}`));
      expect(read.status).toBe(200);
      expect(yield* read.text).toEqual(body);

      const listed = yield* HttpClient.execute(HttpClientRequest.get(`${url}/files`));
      expect((yield* listed.json) as { keys: string[] }).toEqual({ keys: [key] });

      // The object the function wrote is in the bucket, read with another key.
      const stored = yield* withS3(
        { projectId, region },
        s3.getObject({ Bucket: bucketName, Key: key }).pipe(
          Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
        ),
      );
      expect(stored).toEqual(body);

      const removed = yield* HttpClient.execute(HttpClientRequest.delete(`${url}/files/${key}`));
      expect(removed.status).toBe(204);

      const gone = yield* HttpClient.execute(HttpClientRequest.get(`${url}/files/${key}`));
      expect(gone.status).toBe(404);
    }),
    { timeout: 300_000 },
  );
});
