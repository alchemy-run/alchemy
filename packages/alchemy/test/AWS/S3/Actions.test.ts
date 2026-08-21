// Regression suite for Actions whose bodies call AWS SDK operations.
//
// Action bodies run during the `Plan.make` -> `apply` phase, under the
// compiled stack's services — which carry the live AWS environment from
// `AWS.providers()`. Under `ALCHEMY_TEST_DEV=1` (the floci local suite,
// `scripts/test-aws-floci.ts`) that used to leave Action bodies on the live
// default credential chain while the resources they target were provisioned
// in the emulator, so every SDK call inside an Action failed. The harness now
// pins Action runners to the emulator (`pinStackActionsToFloci` in
// Test/Core.ts); this suite exercises Actions against real S3 on the live
// path and against floci on the local path — the same test files run both.
import { Action } from "@/Action.ts";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { FLOCI_ACCOUNT_ID } from "@/AWS/Local/FlociServices.ts";
import { Bucket } from "@/AWS/S3";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Alchemy";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test, deploy, destroy } = Test.make({ providers: AWS.providers() });

// `scripts/test-aws-floci.ts` sets this — the local-dev arm of this suite.
const TEST_DEV =
  process.env.ALCHEMY_TEST_DEV === "1" ||
  process.env.ALCHEMY_TEST_DEV === "true";

// Distinct action input per mode so a durable state row persisted by a live
// run can never satisfy (noop) the floci run of the same test, or vice versa.
const MODE = TEST_DEV ? "local" : "live";

// Reports the AWS environment the Action body actually resolves at apply
// time. Asserting on this identity fails FAST when Action pinning regresses,
// where the behavioral tests below would first hang in SDK retries against
// the wrong cloud.
const ProbeEnv = Action(
  "ProbeEnv",
  Effect.fn(function* (_: { mode: string }) {
    const env = yield* AWSEnvironment.current;
    return { accountId: env.accountId, endpoint: env.endpoint ?? null };
  }),
);

test.provider("action resolves the harness AWS environment", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const out = yield* stack.deploy(
      Effect.gen(function* () {
        return { probe: yield* ProbeEnv({ mode: MODE }) };
      }),
    );

    // The Action body and the test body must resolve the SAME environment —
    // floci (account 000000000000, localhost endpoint) under
    // ALCHEMY_TEST_DEV, the configured live account otherwise.
    const testEnv = yield* AWSEnvironment.current;
    expect(out.probe.accountId).toBe(testEnv.accountId);
    expect(out.probe.endpoint).toBe(testEnv.endpoint ?? null);

    yield* stack.destroy();
  }),
);

const ProbeStack = Alchemy.Stack(
  "S3ActionEnvProbe",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    return { probe: yield* ProbeEnv({ mode: MODE }) };
  }),
);

// Same invariant on the top-level `deploy(Stack)` path, whose plan/apply
// phase runs under `stack.services` inside `evalStack` (a different
// composition than the scratch stack above).
test(
  "action resolves the harness AWS environment via deploy(Stack)",
  Effect.gen(function* () {
    yield* destroy(ProbeStack);
    const out = yield* deploy(ProbeStack);
    if (TEST_DEV) {
      expect(out.probe.accountId).toBe(FLOCI_ACCOUNT_ID);
      expect(out.probe.endpoint).toContain("localhost");
    } else {
      expect(out.probe.accountId).not.toBe(FLOCI_ACCOUNT_ID);
    }
  }).pipe(Effect.ensuring(destroy(ProbeStack).pipe(Effect.ignore))),
);

const ACTION_BODY = "hello from an alchemy action";

// Inline-runner form: the body's S3 calls resolve their environment
// (endpoint, region, credentials) at apply time from the ambient context.
const PutAndStat = Action(
  "PutAndStat",
  Effect.fn(function* (input: { bucketName: string; key: string }) {
    yield* S3.putObject({
      Bucket: input.bucketName,
      Key: input.key,
      Body: ACTION_BODY,
    });
    const head = yield* S3.headObject({
      Bucket: input.bucketName,
      Key: input.key,
    });
    return { contentLength: Number(head.ContentLength ?? 0) };
  }),
);

test.provider(
  "action S3 calls target the same environment as the bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ActionCredsBucket", {
            forceDestroy: true,
          });
          const stat = yield* PutAndStat({
            bucketName: bucket.bucketName,
            key: "action-creds.txt",
          });
          return { bucketName: bucket.bucketName, stat };
        }),
      );

      expect(output.stat.contentLength).toBe(ACTION_BODY.length);

      // The object must also be visible to the test body's S3 client —
      // pinned to the same environment (emulator under ALCHEMY_TEST_DEV,
      // live cloud otherwise) as the bucket and the Action.
      const head = yield* S3.headObject({
        Bucket: output.bucketName,
        Key: "action-creds.txt",
      });
      expect(Number(head.ContentLength)).toBe(ACTION_BODY.length);

      yield* stack.destroy();
      yield* assertBucketDeleted(output.bucketName);
    }),
);

// Init-Effect form: the init captures resource Outputs (`yield* bucket.x`
// records deferred accessors) and the returned runner resolves them at apply
// — combined with SDK calls against TWO resources of the same stack.
test.provider(
  "init-form action with captured outputs copies between buckets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const src = yield* Bucket("CopySrcBucket", { forceDestroy: true });
          const dest = yield* Bucket("CopyDestBucket", { forceDestroy: true });

          const CopyObject = Action(
            "CopyObject",
            Effect.gen(function* () {
              // Captured at init, before either bucket exists.
              const srcName = yield* src.bucketName;
              const destName = yield* dest.bucketName;
              return Effect.fn(function* (input: {
                key: string;
                body: string;
              }) {
                const srcBucket = yield* srcName;
                const destBucket = yield* destName;
                yield* S3.putObject({
                  Bucket: srcBucket,
                  Key: input.key,
                  Body: input.body,
                });
                yield* S3.copyObject({
                  Bucket: destBucket,
                  Key: input.key,
                  CopySource: `${srcBucket}/${input.key}`,
                });
                const copied = yield* S3.headObject({
                  Bucket: destBucket,
                  Key: input.key,
                });
                return { copiedLength: Number(copied.ContentLength ?? 0) };
              });
            }),
          );

          const copy = yield* CopyObject({
            key: "copied.txt",
            body: "copy me",
          });
          return {
            srcName: src.bucketName,
            destName: dest.bucketName,
            copy,
          };
        }),
      );

      expect(output.copy.copiedLength).toBe("copy me".length);

      const head = yield* S3.headObject({
        Bucket: output.destName,
        Key: "copied.txt",
      });
      expect(Number(head.ContentLength)).toBe("copy me".length);

      yield* stack.destroy();
      yield* assertBucketDeleted(output.srcName);
      yield* assertBucketDeleted(output.destName);
    }),
);

const PutKey = Action(
  "PutKey",
  Effect.fn(function* (input: { bucketName: string; key: string }) {
    yield* S3.putObject({
      Bucket: input.bucketName,
      Key: input.key,
      Body: "rerun",
    });
    return { key: input.key };
  }),
);

// The update path: a changed input re-runs the Action body during the second
// deploy's apply — that body must hit the same environment as the first run.
test.provider(
  "action re-runs on input change in the same environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (key: string) =>
        Effect.gen(function* () {
          const bucket = yield* Bucket("RerunBucket", { forceDestroy: true });
          const put = yield* PutKey({ bucketName: bucket.bucketName, key });
          return { bucketName: bucket.bucketName, put };
        });

      const first = yield* stack.deploy(program("first.txt"));
      expect(first.put.key).toBe("first.txt");

      const second = yield* stack.deploy(program("second.txt"));
      expect(second.put.key).toBe("second.txt");

      const head = yield* S3.headObject({
        Bucket: second.bucketName,
        Key: "second.txt",
      });
      expect(Number(head.ContentLength)).toBe("rerun".length);

      yield* stack.destroy();
      yield* assertBucketDeleted(second.bucketName);
    }),
);

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
