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
import type { Task } from "../src/TaskApi.ts";

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

describe("stackit-httpapi", () => {
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
    "creates a task and reads it back",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const created = yield* expectStatus(
        HttpClientRequest.post(`${url}/tasks`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "write docs" }),
        ),
        200,
      );
      const task = (yield* created.json) as unknown as Task;
      expect(task.title).toEqual("write docs");

      const read = yield* expectStatus(HttpClientRequest.get(`${url}/tasks/${task.id}`), 200);
      expect((yield* read.json) as unknown as Task).toEqual(task);
    }),
    { timeout: 300_000 },
  );

  test(
    "an unknown task is a 404, and a bad payload a 400",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* expectStatus(HttpClientRequest.get(`${url}/tasks/unknown`), 404);
      yield* expectStatus(
        HttpClientRequest.post(`${url}/tasks`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: 42 }),
        ),
        400,
      );
    }),
    { timeout: 300_000 },
  );

  test(
    "the function is active",
    Effect.gen(function* () {
      const { projectId, functionId } = yield* stack;
      const fn = yield* functions
        .getFunction({ projectId, functionId })
        .pipe(Effect.provide(StackitCloud));
      expect(fn.state).toEqual("ACTIVE");
    }),
    { timeout: 120_000 },
  );
});
