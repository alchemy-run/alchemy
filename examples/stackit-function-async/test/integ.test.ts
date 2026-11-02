import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as functions from "@distilled.cloud/stackit/functions";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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

/** A request that has to answer `status`, retried while a fresh function and key settle. */
const expectStatus = (request: HttpClientRequest.HttpClientRequest, status: number) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.succeed(response)
        : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-function-async", () => {
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
    "the handler reads its env",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* expectStatus(HttpClientRequest.get(`${url}/`), 200);
      expect(yield* response.text).toEqual("hello from an async function");
    }),
    { timeout: 300_000 },
  );

  test(
    "the revision runs a pinned image and holds the variables",
    Effect.gen(function* () {
      const { projectId, functionId } = yield* stack;
      const revision = yield* functions.getFunction({ projectId, functionId }).pipe(
        Effect.flatMap((fn) =>
          functions.getRevision({ projectId, functionId, revisionId: fn.current_revision! }),
        ),
        Effect.provide(StackitCloud),
      );
      expect(revision.oci_reference).toMatch(/\/notes@sha256:[a-f0-9]{64}$/);
      expect((revision.variables ?? []).map((variable) => variable.name)).toContain("S3_BUCKET");
    }),
    { timeout: 120_000 },
  );

  test(
    "stores a note in the bucket with a plain S3 client",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const body = "written by Bun.S3Client";

      yield* expectStatus(
        HttpClientRequest.put(`${url}/notes/first`).pipe(HttpClientRequest.bodyText(body)),
        204,
      );

      const read = yield* expectStatus(HttpClientRequest.get(`${url}/notes/first`), 200);
      expect(yield* read.text).toEqual(body);

      const missing = yield* HttpClient.execute(HttpClientRequest.get(`${url}/notes/missing`));
      expect(missing.status).toBe(404);
    }),
    { timeout: 300_000 },
  );
});
