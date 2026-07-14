import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { Canary } from "@/AWS/Synthetics";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as synthetics from "@distilled.cloud/aws/synthetics";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Trivial heartbeat script — no page load, just a successful step.
const HEARTBEAT_SCRIPT = `
const synthetics = require("Synthetics");
const log = require("SyntheticsLogger");

exports.handler = async function () {
  return await synthetics.executeStep("heartbeat", async function () {
    log.info("heartbeat ok");
  });
};
`;

// The provider's delete waits until the canary is gone, so this should
// resolve quickly; the bounded retry covers read-after-delete lag. It also
// pins the distilled patch: getCanary's typed ResourceNotFoundException.
const assertCanaryGone = (canaryName: string) =>
  synthetics.getCanary({ Name: canaryName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`canary ${canaryName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

describe.sequential("AWS.Synthetics.Canary", () => {
  test.provider(
    "creates a stopped canary, updates the schedule, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployCanary = (scheduleExpression: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* Bucket("CanaryArtifacts", {
                forceDestroy: true,
              });
              const canary = yield* Canary("Heartbeat", {
                script: HEARTBEAT_SCRIPT,
                artifactS3Location: Output.interpolate`s3://${bucket.bucketName}/heartbeat`,
                schedule: { expression: scheduleExpression },
              });
              return {
                canaryName: canary.canaryName,
                canaryArn: canary.canaryArn,
                executionRoleArn: canary.executionRoleArn,
              };
            }),
          );

        const created = yield* deployCanary("rate(5 minutes)");

        // Out-of-band verification via distilled.
        const observed = yield* synthetics.getCanary({
          Name: created.canaryName,
        });
        // Never started → READY (a stopped-after-running canary is STOPPED).
        expect(["READY", "STOPPED"]).toContain(observed.Canary?.Status?.State);
        expect(observed.Canary?.RuntimeVersion).toBe(
          "syn-nodejs-puppeteer-16.1",
        );
        expect(observed.Canary?.Schedule?.Expression).toBe("rate(5 minutes)");
        expect(observed.Canary?.ExecutionRoleArn).toBe(
          created.executionRoleArn,
        );
        expect(observed.Canary?.Tags?.["alchemy::id"]).toBe("Heartbeat");

        // Update the schedule in place (same physical name).
        const updated = yield* deployCanary("rate(10 minutes)");
        expect(updated.canaryName).toBe(created.canaryName);
        const observedUpdated = yield* synthetics.getCanary({
          Name: created.canaryName,
        });
        expect(observedUpdated.Canary?.Schedule?.Expression).toBe(
          "rate(10 minutes)",
        );

        yield* stack.destroy();
        yield* assertCanaryGone(created.canaryName);
      }),
    { timeout: 420_000 },
  );

  // A live canary run takes ~1-2 minutes end to end — gated behind
  // AWS_TEST_SLOW=1.
  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "starts the canary and records a successful run",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { canaryName } = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("RunArtifacts", {
              forceDestroy: true,
            });
            const canary = yield* Canary("HeartbeatRun", {
              script: HEARTBEAT_SCRIPT,
              artifactS3Location: Output.interpolate`s3://${bucket.bucketName}/run`,
              schedule: { expression: "rate(1 minute)" },
              start: true,
            });
            return { canaryName: canary.canaryName };
          }),
        );

        const running = yield* synthetics.getCanary({ Name: canaryName });
        expect(running.Canary?.Status?.State).toBe("RUNNING");

        // Poll for the first completed successful run.
        const passedRun = yield* synthetics
          .getCanaryRuns({ Name: canaryName })
          .pipe(
            Effect.map((r) =>
              (r.CanaryRuns ?? []).find(
                (run) => run.Status?.State === "PASSED",
              ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (run) => run !== undefined,
              times: 24,
            }),
          );
        expect(passedRun?.Status?.State).toBe("PASSED");

        yield* stack.destroy();
        yield* assertCanaryGone(canaryName);
      }),
    { timeout: 600_000 },
  );
});
