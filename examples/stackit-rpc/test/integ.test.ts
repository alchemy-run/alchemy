import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as functions from "@distilled.cloud/stackit/functions";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { TaskRpcs } from "../src/TaskRpcs.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

const protocolAt = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson),
  );

describe("stackit-rpc", () => {
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

      yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(TaskRpcs);

        // A fresh function, its key and the bucket's policy take a moment to settle.
        const task = yield* client
          .createTask({ title: "write docs" })
          .pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));
        expect(task.title).toEqual("write docs");

        const read = yield* client.getTask({ id: task.id });
        expect(read.id).toEqual(task.id);
      }).pipe(Effect.scoped, Effect.provide(protocolAt(url!)));
    }),
    { timeout: 300_000 },
  );

  test(
    "an unknown task is a typed error",
    Effect.gen(function* () {
      const { url } = yield* stack;

      yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(TaskRpcs);

        const error = yield* client.getTask({ id: "unknown" }).pipe(
          Effect.retry({
            while: (error) => error._tag !== "TaskNotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 24,
          }),
          Effect.flip,
        );
        expect(error._tag).toEqual("TaskNotFound");
      }).pipe(Effect.scoped, Effect.provide(protocolAt(url!)));
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
