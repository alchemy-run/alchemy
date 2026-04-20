import * as AWS from "@/AWS";
import { Bucket, STATE_BUCKET_TAG, state } from "@/AWS/S3";
import { destroy } from "@/Destroy";
import * as State from "@/State";
import { test } from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const deployStateBucket = (suffix: string) =>
  test.deploy(
    Effect.gen(function* () {
      return yield* Bucket(`S3State${suffix}`, {
        forceDestroy: true,
      });
    }),
  );

const sampleResourceState = (fqn: string): State.ResourceState => ({
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: `${fqn}-inst`,
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: { foo: "bar" },
  attr: { arn: `arn:fake:${fqn}` },
});

test(
  "fails loudly if the named bucket does not exist",
  Effect.gen(function* () {
    const missing = "alchemy-state-missing-probe-test";

    // Acquiring State forces the layer to build, triggering the probe.
    const result = yield* Effect.gen(function* () {
      return yield* State.State;
    }).pipe(Effect.provide(state({ bucketName: missing })), Effect.flip);

    expect(result).toBeInstanceOf(State.StateStoreError);
    expect((result as State.StateStoreError).message).toContain(missing);
    expect((result as State.StateStoreError).message).toContain(
      "does not exist",
    );
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "set / get / list / delete round-trip against a real bucket",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const bucket = yield* deployStateBucket("RoundTrip");
    const bucketName = bucket.bucketName;

    const s3StateLayer = state({
      bucketName,
      prefix: "alchemy-test/",
    });

    yield* Effect.gen(function* () {
      const svc = yield* State.State;

      const stack = "stack-a";
      const stage = "dev";

      expect(yield* svc.list({ stack, stage })).toEqual([]);
      expect(yield* svc.get({ stack, stage, fqn: "Missing" })).toBeUndefined();

      const r1 = sampleResourceState("Foo/Bar");
      const r2 = sampleResourceState("Baz");
      yield* svc.set({ stack, stage, fqn: r1.fqn, value: r1 });
      yield* svc.set({ stack, stage, fqn: r2.fqn, value: r2 });

      // FQN slashes survive the encode/decode round-trip.
      const listed = yield* svc.list({ stack, stage });
      expect(listed.sort()).toEqual(["Baz", "Foo/Bar"]);

      const got = yield* svc.get({ stack, stage, fqn: "Foo/Bar" });
      expect(got).toMatchObject({
        fqn: "Foo/Bar",
        status: "created",
        attr: { arn: "arn:fake:Foo/Bar" },
      });

      expect(yield* svc.listStacks()).toContain(stack);
      expect(yield* svc.listStages(stack)).toEqual([stage]);

      // Double-delete must not throw.
      yield* svc.delete({ stack, stage, fqn: "Foo/Bar" });
      yield* svc.delete({ stack, stage, fqn: "Foo/Bar" });

      expect(yield* svc.list({ stack, stage })).toEqual(["Baz"]);
      expect(yield* svc.get({ stack, stage, fqn: "Foo/Bar" })).toBeUndefined();
    }).pipe(Effect.provide(s3StateLayer));

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "auto-provisions and rediscovers a tagged state bucket",
  { timeout: 180_000 },
  Effect.gen(function* () {
    // First build creates + tags; second rediscovers via tag.
    yield* Effect.gen(function* () {
      const svc = yield* State.State;
      yield* svc.set({
        stack: "auto-stack",
        stage: "dev",
        fqn: "AutoResource",
        value: sampleResourceState("AutoResource"),
      });
    }).pipe(Effect.provide(state({ prefix: "alchemy-auto-test/" })));

    const buckets = (yield* S3.listBuckets({})).Buckets ?? [];
    const tagged: string[] = [];
    for (const b of buckets) {
      if (!b.Name) continue;
      const tagging = yield* S3.getBucketTagging({ Bucket: b.Name }).pipe(
        Effect.map((r) => r.TagSet ?? []),
        Effect.catch(() =>
          Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
        ),
      );
      if (
        tagging.some((t) => t.Key === STATE_BUCKET_TAG && t.Value === "true")
      ) {
        tagged.push(b.Name);
      }
    }
    expect(tagged.length).toBeGreaterThanOrEqual(1);

    yield* Effect.gen(function* () {
      const svc = yield* State.State;
      const got = yield* svc.get({
        stack: "auto-stack",
        stage: "dev",
        fqn: "AutoResource",
      });
      expect(got?.fqn).toBe("AutoResource");
    }).pipe(Effect.provide(state({ prefix: "alchemy-auto-test/" })));

    // Teardown so the next run starts clean.
    for (const bucketName of tagged) {
      yield* S3.listObjectsV2.pages({ Bucket: bucketName }).pipe(
        Stream.runForEach((page) => {
          const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
          return keys.length === 0
            ? Effect.void
            : S3.deleteObjects({
                Bucket: bucketName,
                Delete: { Objects: keys, Quiet: true },
              }).pipe(Effect.asVoid);
        }),
      );
      yield* S3.deleteBucket({ Bucket: bucketName });
    }
  }).pipe(Effect.provide(AWS.providers())),
);
