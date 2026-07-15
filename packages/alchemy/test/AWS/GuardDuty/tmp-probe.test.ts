import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const DETECTOR_ARN =
  "arn:aws:guardduty:us-west-2:391965393224:detector/e8209601253a4a258e35c0df41fb370e";

const ACTIONS = [
  "guardduty:ListMembers",
  "guardduty:ListFindings",
  "guardduty:GetFindings",
  "guardduty:ListCoverage",
  "guardduty:CreateSampleFindings",
];

test.provider(
  "probe: resource formats accepted by guardduty actions",
  (_stack) =>
    Effect.gen(function* () {
      for (const resource of [
        "arn:aws:guardduty:us-west-2:391965393224:detector/*",
        "arn:aws:guardduty:*:391965393224:*",
        "*",
      ]) {
        const policy = JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["*"], Resource: [resource] }],
        });
        const sim = yield* Effect.result(
          iam.simulateCustomPolicy({
            PolicyInputList: [policy],
            ActionNames: ACTIONS,
            ResourceArns: [DETECTOR_ARN],
          }),
        );
        console.log("== Resource:", resource);
        if (Result.isSuccess(sim)) {
          for (const r of sim.success.EvaluationResults ?? []) {
            console.log(" ", r.EvalActionName, "=>", r.EvalDecision);
          }
        } else {
          console.log("simulate FAILED:", String(sim.failure));
        }
      }
    }),
  { timeout: 90_000 },
);
