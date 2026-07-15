import * as AWS from "@/AWS";
import { TelemetryRule } from "@/AWS/ObservabilityAdmin";
import * as Test from "@/Test/Vitest";
import * as obs from "@distilled.cloud/aws/observabilityadmin";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const readStatus = obs
  .getTelemetryEvaluationStatus({})
  .pipe(Effect.map((r) => r.Status ?? "NOT_STARTED"));

// Bounded wait for the account-wide telemetry config toggle to settle.
const awaitSettled = readStatus.pipe(
  Effect.repeat({
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
    until: (status): boolean => status !== "STARTING" && status !== "STOPPING",
  }),
);

const isOn = (status: string): boolean =>
  status === "RUNNING" || status === "STARTING";

/** Restore the account's telemetry config onboarding to its pre-test state. */
const restoreTo = (prior: string) =>
  Effect.gen(function* () {
    const settled = yield* awaitSettled;
    if (isOn(prior) && !isOn(settled)) {
      yield* obs.startTelemetryEvaluation({});
      yield* awaitSettled;
    }
    if (!isOn(prior) && isOn(settled)) {
      yield* obs.stopTelemetryEvaluation({});
      yield* awaitSettled;
    }
  });

// Telemetry rules require the account-wide telemetry config feature, so run
// sequentially and capture-and-restore the onboarding state.
describe.sequential("AWS.ObservabilityAdmin.TelemetryRule", () => {
  test.provider(
    "creates, updates in place, and deletes a telemetry rule",
    (stack) =>
      Effect.gen(function* () {
        // Capture the account's pre-test onboarding state; rules need the
        // feature RUNNING, and destroy must restore whatever was there.
        const before = yield* awaitSettled;

        yield* Effect.gen(function* () {
          if (!isOn(before)) {
            yield* obs.startTelemetryEvaluation({});
            yield* awaitSettled;
          }

          yield* stack.destroy();

          const deployRule = (retention: string) =>
            stack.deploy(
              Effect.gen(function* () {
                // The rule exists for well under the ~24h AWS Config
                // discovery window, so it never actually configures flow
                // logs (same shape as the terraform-provider-aws
                // acceptance tests).
                const rule = yield* TelemetryRule("Rule", {
                  resourceType: "AWS::EC2::VPC",
                  telemetryType: "Logs",
                  telemetrySourceTypes: ["VPC_FLOW_LOGS"],
                  destinationConfiguration: {
                    DestinationType: "cloud-watch-logs",
                    Retention: retention,
                  },
                });
                return {
                  ruleName: rule.ruleName,
                  ruleArn: rule.ruleArn,
                  telemetryType: rule.telemetryType,
                  resourceType: rule.resourceType,
                };
              }),
            );

          // Create.
          const created = yield* deployRule("30 days");
          expect(created.ruleName).toBeTruthy();
          expect(created.ruleArn).toContain("telemetry-rule");
          expect(created.telemetryType).toBe("Logs");
          expect(created.resourceType).toBe("AWS::EC2::VPC");
          const got = yield* obs.getTelemetryRule({
            RuleIdentifier: created.ruleName,
          });
          expect(
            got.TelemetryRule?.DestinationConfiguration?.RetentionInDays,
          ).toBe(30);

          // Update in place — the Duration prop lands as whole wire days and
          // the ARN is stable (no replacement).
          const updated = yield* deployRule("60 days");
          expect(updated.ruleArn).toBe(created.ruleArn);
          const got2 = yield* obs.getTelemetryRule({
            RuleIdentifier: created.ruleName,
          });
          expect(
            got2.TelemetryRule?.DestinationConfiguration?.RetentionInDays,
          ).toBe(60);

          // Destroy — the rule is gone (typed check, not a catch-all).
          yield* stack.destroy();
          const gone = yield* obs
            .getTelemetryRule({ RuleIdentifier: created.ruleName })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          expect(gone).toBe(true);
        }).pipe(
          // Always restore the account's onboarding state, even on failure.
          Effect.ensuring(restoreTo(before).pipe(Effect.ignore)),
        );
      }),
    { timeout: 180_000 },
  );
});
