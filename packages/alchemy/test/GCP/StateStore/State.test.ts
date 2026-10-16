import { createHash } from "node:crypto";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as GCP from "@/GCP";
import { makeGcsState } from "@/GCP";
import { makeObjectMedia } from "@/GCP/Storage/ObjectMedia.ts";
import type { ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: GCP.providers() });

const STACK = "GcsStateStoreTestStack";

const tags = ["provider:gcp", "provider:gcp:storage", "provider:gcp:statestore", "live"];

// Versioning and uniform access match what the store enforces, so the
// store never drifts the bucket away from the resource's own state.
const StateBucket = GCP.Storage.Bucket("StateBucket", {
  versioning: true,
  uniformBucketLevelAccess: true,
  forceDestroy: true,
});

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

/** The lock object, or `undefined` when no store holds the stage. */
const readLock = (bucket: string, object: string) =>
  storage
    .getObjects({ bucket, object })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/** Plant a lock object directly, as another deploy would have left it. */
const plantLock = (bucket: string, object: string, token: string, expiresInMs: number) =>
  Effect.gen(function* () {
    const media = yield* makeObjectMedia;
    const now = yield* Clock.currentTimeMillis;
    return yield* media.create(bucket, {
      name: object,
      body: "",
      metadata: { token, expiresAt: new Date(now + expiresInMs).toISOString() },
    });
  });

test.provider(
  "set/get/list/delete round-trips state and outputs through GCS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(StateBucket);
      const stage = "round-trip";

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeGcsState({
            bucketName: bucket.bucketName,
            prefix: "test-state",
          });
          const a = resource("Parent/ResourceA", { value: "a" });
          const b = resource("ResourceB", { value: "b" });
          const replaced = {
            ...resource("Replaced", { value: "r" }),
            status: "replaced",
          } as ResourceState;

          yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
          yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });
          yield* state.set({ stack: STACK, stage, fqn: replaced.fqn, value: replaced });
          yield* state.setOutput({ stack: STACK, stage, value: { url: "https://example.com" } });

          expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
          expect(yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" })).toBeUndefined();
          expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
            url: "https://example.com",
          });
          // Neither the output object nor the lock object is a resource.
          expect([...(yield* state.list({ stack: STACK, stage }))].sort()).toEqual([
            "Parent/ResourceA",
            "Replaced",
            "ResourceB",
          ]);
          expect(
            (yield* state.getReplacedResources({ stack: STACK, stage })).map((r) => r.fqn),
          ).toEqual(["Replaced"]);
          expect(yield* state.listStacks()).toEqual([STACK]);
          expect(yield* state.listStages(STACK)).toEqual([stage]);

          yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
          expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toBeUndefined();
          // deleting a missing resource is a no-op
          yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

          yield* state.deleteStack({ stack: STACK, stage });
          expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
          expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
          // The lock is still held, but the deleted stage is gone.
          expect(yield* state.listStages(STACK)).toEqual([]);
        }),
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a second deploy of a stage fails while the first holds its lock",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(StateBucket);
      const options = { bucketName: bucket.bucketName, prefix: "lock" };
      const stage = "held";
      const lock = `lock/__locks__/${STACK}/${stage}`;
      const first = resource("Vpc", { vpcId: "first" });
      const second = resource("Vpc", { vpcId: "second" });
      const request = { stack: STACK, stage, fqn: first.fqn };

      const holderScope = yield* Scope.make();
      yield* Effect.gen(function* () {
        const holder = yield* makeGcsState(options).pipe(Scope.provide(holderScope));
        yield* holder.set({ ...request, value: first });

        // The holder refreshes its lock in place: same generation, new
        // metageneration.
        const taken = yield* storage.getObjects({ bucket: bucket.bucketName, object: lock });
        const refreshed = yield* readLock(bucket.bucketName, lock).pipe(
          Effect.repeat({
            until: (live) => live?.metageneration !== taken.metageneration,
            schedule: Schedule.spaced("1 second"),
            times: 30,
          }),
        );
        expect(refreshed?.generation).toEqual(taken.generation);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const contender = yield* makeGcsState(options);
            const blocked = yield* contender.set({ ...request, value: second }).pipe(Effect.flip);
            expect(blocked.message).toContain("another deploy holds the GCS state lock");
            expect(yield* holder.get(request)).toEqual(first);

            // Closing the first store releases its lock.
            yield* Scope.close(holderScope, Exit.void);
            expect(yield* readLock(bucket.bucketName, lock)).toBeUndefined();

            yield* contender.set({ ...request, value: second });
            expect(yield* contender.get(request)).toEqual(second);
            yield* contender.deleteStack({ stack: STACK, stage });
          }),
        );
      }).pipe(Effect.ensuring(Scope.close(holderScope, Exit.void)));

      expect(yield* readLock(bucket.bucketName, lock)).toBeUndefined();
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an expired lock is taken over, and the store it was taken from stops",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(StateBucket);
      const options = { bucketName: bucket.bucketName, prefix: "expiry" };
      const stage = "expired";
      const lock = `expiry/__locks__/${STACK}/${stage}`;
      const row = resource("Vpc", { vpcId: "taken-over" });
      const request = { stack: STACK, stage, fqn: row.fqn };

      // A deploy that crashed a minute ago left its lock behind.
      const crashed = yield* plantLock(bucket.bucketName, lock, "crashed", -60_000);

      const successor = yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeGcsState(options);
          yield* state.set({ ...request, value: row });
          const taken = yield* storage.getObjects({ bucket: bucket.bucketName, object: lock });
          expect(taken.generation).not.toEqual(crashed.generation);
          expect(taken.metadata?.token).not.toEqual("crashed");
          expect(yield* state.get(request)).toEqual(row);
          yield* state.deleteStack({ stack: STACK, stage });

          // Another deploy replaces the lock, as it may once this store's
          // lock has expired.
          yield* storage.deleteObjects({
            bucket: bucket.bucketName,
            object: lock,
            ifGenerationMatch: taken.generation,
          });
          const successor = yield* plantLock(bucket.bucketName, lock, "successor", 60_000);
          // The store's next refresh, at most 20 seconds away, finds
          // another generation.
          const lost = yield* state
            .get(request)
            .pipe(Effect.flip, Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));
          expect(lost.message).toContain("was lost mid-run");
          return successor;
        }),
      );

      // Closing the displaced store left the successor's lock alone.
      expect((yield* readLock(bucket.bucketName, lock))?.generation).toEqual(successor.generation);
      yield* storage.deleteObjects({ bucket: bucket.bucketName, object: lock });
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a missing state bucket is created private",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GCP.GcpEnvironment.current;
      const suffix = yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      );
      const bucketName = `alchemy-state-test-${suffix}-${project}`;
      // `listStacks` takes no lock and writes nothing, so the bucket stays
      // empty and a plain delete removes it.
      const deleteBucket = storage
        .deleteBuckets({ bucket: bucketName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));

      yield* deleteBucket;
      yield* Effect.gen(function* () {
        const stacks = yield* Effect.scoped(
          makeGcsState({ bucketName }).pipe(Effect.flatMap((state) => state.listStacks())),
        );
        expect(stacks).toEqual([]);
        const bucket = yield* storage.getBuckets({ bucket: bucketName });
        expect(bucket.versioning?.enabled).toBe(true);
        expect(bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled).toBe(true);
        expect(bucket.iamConfiguration?.publicAccessPrevention).toBe("enforced");
      }).pipe(Effect.ensuring(deleteBucket.pipe(Effect.orDie)));
    }),
  { tags, timeout: 120_000 },
);
