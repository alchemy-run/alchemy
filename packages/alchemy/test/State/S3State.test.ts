import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { destroy } from "@/Destroy";
import * as State from "@/State";
import { test } from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
  "fails loudly if the bucket does not exist",
  Effect.gen(function* () {
    const missing = `alchemy-state-missing-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;

    const result = yield* Effect.gen(function* () {
      // Force the layer to build by acquiring State — this triggers the
      // bucket-existence probe in the layer's construction effect.
      return yield* State.State;
    }).pipe(
      Effect.provide(State.S3State({ bucketName: missing })),
      Effect.flip,
    );

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

    const s3StateLayer = State.S3State({
      bucketName,
      prefix: "alchemy-test/",
    });

    yield* Effect.gen(function* () {
      const state = yield* State.State;

      const stack = "stack-a";
      const stage = "dev";

      // list on an empty stage is empty
      const empty = yield* state.list({ stack, stage });
      expect(empty).toEqual([]);

      // get for a missing key returns undefined
      const missing = yield* state.get({ stack, stage, fqn: "Missing" });
      expect(missing).toBeUndefined();

      // set two resources
      const r1 = sampleResourceState("Foo/Bar");
      const r2 = sampleResourceState("Baz");
      yield* state.set({ stack, stage, fqn: r1.fqn, value: r1 });
      yield* state.set({ stack, stage, fqn: r2.fqn, value: r2 });

      // list returns both, FQN-decoded (slashes preserved)
      const listed = yield* state.list({ stack, stage });
      expect(listed.sort()).toEqual(["Baz", "Foo/Bar"]);

      // get returns the stored value
      const got = yield* state.get({ stack, stage, fqn: "Foo/Bar" });
      expect(got).toMatchObject({
        fqn: "Foo/Bar",
        status: "created",
        attr: { arn: "arn:fake:Foo/Bar" },
      });

      // listStacks / listStages reflect the written keys
      const stacks = yield* state.listStacks();
      expect(stacks).toContain(stack);

      const stages = yield* state.listStages(stack);
      expect(stages).toEqual([stage]);

      // delete is idempotent
      yield* state.delete({ stack, stage, fqn: "Foo/Bar" });
      yield* state.delete({ stack, stage, fqn: "Foo/Bar" });

      const afterDelete = yield* state.list({ stack, stage });
      expect(afterDelete).toEqual(["Baz"]);

      const goneGet = yield* state.get({ stack, stage, fqn: "Foo/Bar" });
      expect(goneGet).toBeUndefined();
    }).pipe(Effect.provide(s3StateLayer));

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "isolates stacks and stages under the shared prefix",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const bucket = yield* deployStateBucket("Isolation");
    const bucketName = bucket.bucketName;

    const s3StateLayer = State.S3State({
      bucketName,
      prefix: "alchemy-test/",
    });

    yield* Effect.gen(function* () {
      const state = yield* State.State;

      const a = sampleResourceState("ResourceA");
      const b = sampleResourceState("ResourceB");

      yield* state.set({
        stack: "stack-1",
        stage: "dev",
        fqn: a.fqn,
        value: a,
      });
      yield* state.set({
        stack: "stack-1",
        stage: "prod",
        fqn: a.fqn,
        value: a,
      });
      yield* state.set({
        stack: "stack-2",
        stage: "dev",
        fqn: b.fqn,
        value: b,
      });

      const stacks = yield* state.listStacks();
      expect(stacks.sort()).toEqual(["stack-1", "stack-2"]);

      const s1Stages = yield* state.listStages("stack-1");
      expect(s1Stages.sort()).toEqual(["dev", "prod"]);

      const s2Stages = yield* state.listStages("stack-2");
      expect(s2Stages).toEqual(["dev"]);

      // Each stage lists only its own keys.
      const s1Dev = yield* state.list({ stack: "stack-1", stage: "dev" });
      expect(s1Dev).toEqual(["ResourceA"]);

      const s2Dev = yield* state.list({ stack: "stack-2", stage: "dev" });
      expect(s2Dev).toEqual(["ResourceB"]);
    }).pipe(Effect.provide(s3StateLayer));

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "getReplacedResources returns only replaced states",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const bucket = yield* deployStateBucket("Replaced");
    const bucketName = bucket.bucketName;

    const s3StateLayer = State.S3State({
      bucketName,
      prefix: "alchemy-test/",
    });

    yield* Effect.gen(function* () {
      const state = yield* State.State;

      const stack = "replaced-stack";
      const stage = "dev";

      const created = sampleResourceState("AliveResource");
      const replacedValue: State.ResourceState = {
        ...sampleResourceState("ReplacedResource"),
        status: "replaced",
        deleteFirst: false,
        attr: { arn: "arn:fake:ReplacedResource" },
        old: {
          ...sampleResourceState("ReplacedResource"),
          status: "created",
          attr: { arn: "arn:fake:ReplacedResource:old" },
        },
      } as State.ResourceState;

      yield* state.set({
        stack,
        stage,
        fqn: created.fqn,
        value: created,
      });
      yield* state.set({
        stack,
        stage,
        fqn: replacedValue.fqn,
        value: replacedValue,
      });

      const replaced = yield* state.getReplacedResources({ stack, stage });
      expect(replaced).toHaveLength(1);
      expect(replaced[0]!.fqn).toBe("ReplacedResource");
      expect(replaced[0]!.status).toBe("replaced");
    }).pipe(Effect.provide(s3StateLayer));

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "object layout uses ${prefix}${stack}/${stage}/${encodeFqn(fqn)}.json",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const bucket = yield* deployStateBucket("KeyLayout");
    const bucketName = bucket.bucketName;

    const s3StateLayer = State.S3State({
      bucketName,
      prefix: "alchemy-test/",
    });

    yield* Effect.gen(function* () {
      const state = yield* State.State;
      const resource = sampleResourceState("Ns/Inner/Leaf");
      yield* state.set({
        stack: "my-stack",
        stage: "dev",
        fqn: resource.fqn,
        value: resource,
      });
    }).pipe(Effect.provide(s3StateLayer));

    const listed = yield* S3.listObjectsV2({
      Bucket: bucketName,
      Prefix: "alchemy-test/",
    });
    const keys = (listed.Contents ?? []).map((c) => c.Key);
    expect(keys).toContain(
      "alchemy-test/my-stack/dev/Ns__Inner__Leaf.json",
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);
