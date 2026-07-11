import * as AWS from "@/AWS";
import { ConfigRule } from "@/AWS/Config";
import * as Test from "@/Test/Vitest";
import * as config from "@distilled.cloud/aws/config-service";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "describeConfigRules on a nonexistent rule fails with NoSuchConfigRuleException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        config.describeConfigRules({
          ConfigRuleNames: ["alchemy-nonexistent-config-rule-probe"],
        }),
      );
      expect(error._tag).toBe("NoSuchConfigRuleException");
    }),
);

const findRule = (ruleName: string) =>
  config.describeConfigRules({ ConfigRuleNames: [ruleName] }).pipe(
    Effect.map((r) => (r.ConfigRules ?? []).at(0)),
    Effect.catchTag("NoSuchConfigRuleException", () =>
      Effect.succeed(undefined),
    ),
  );

class RuleStillExists extends Data.TaggedError("RuleStillExists")<{
  readonly ruleName: string;
  readonly state: string;
}> {}

// Rule deletion is asynchronous — DELETING is an irreversible terminal
// trajectory, so gone-or-DELETING both count as deleted.
const assertRuleDeleting = (ruleName: string) =>
  findRule(ruleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined || rule.ConfigRuleState === "DELETING"
        ? Effect.void
        : Effect.fail(
            new RuleStillExists({
              ruleName,
              state: rule.ConfigRuleState ?? "unknown",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "RuleStillExists",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

// PutConfigRule requires a configuration recorder in the account/region
// (NoAvailableConfigurationRecorderException otherwise). Capture-and-restore:
// if the account has none, stand up a minimal recorder on the Config
// service-linked role for the duration of the test and delete it afterwards;
// an existing recorder is left untouched.
const ensureRecorder = Effect.gen(function* () {
  const existing = yield* config.describeConfigurationRecorders({});
  if ((existing.ConfigurationRecorders ?? []).length > 0) {
    return false;
  }
  yield* iam
    .createServiceLinkedRole({ AWSServiceName: "config.amazonaws.com" })
    .pipe(
      Effect.catchTag("InvalidInputException", () => Effect.succeed(undefined)),
    );
  const role = yield* iam.getRole({ RoleName: "AWSServiceRoleForConfig" });
  // A freshly-created service-linked role can be transiently rejected until
  // IAM propagates.
  yield* config
    .putConfigurationRecorder({
      ConfigurationRecorder: {
        name: "default",
        roleARN: role.Role.Arn,
        recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
      },
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "InvalidRoleException",
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(15)),
        ),
      }),
    );
  return true;
});

const removeRecorderIfCreated = (created: boolean) =>
  created
    ? config
        .deleteConfigurationRecorder({ ConfigurationRecorderName: "default" })
        .pipe(Effect.ignore)
    : Effect.void;

test.provider(
  "create, update, replace on rename, delete managed config rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const createdRecorder = yield* ensureRecorder;

      yield* Effect.gen(function* () {
        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              description: "buckets must have versioning enabled",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
              tags: { Environment: "test" },
            });
          }),
        );

        expect(rule.configRuleName).toBeDefined();
        expect(rule.configRuleArn).toContain(":config-rule/");
        expect(rule.configRuleId).toContain("config-rule-");

        // Out-of-band verification via distilled.
        const created = yield* findRule(rule.configRuleName);
        expect(created?.Source.Owner).toBe("AWS");
        expect(created?.Source.SourceIdentifier).toBe(
          "S3_BUCKET_VERSIONING_ENABLED",
        );
        expect(created?.Description).toBe(
          "buckets must have versioning enabled",
        );
        expect(created?.Scope?.ComplianceResourceTypes).toEqual([
          "AWS::S3::Bucket",
        ]);
        const tags = yield* config
          .listTagsForResource({ ResourceArn: rule.configRuleArn })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
            ),
          );
        expect(tags.Environment).toBe("test");
        expect(tags["alchemy::id"]).toBe("VersioningRule");

        // Update the description and tags in place.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              description: "buckets must have versioning enabled (v2)",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
              tags: { Environment: "prod" },
            });
          }),
        );
        expect(updated.configRuleName).toBe(rule.configRuleName);
        expect(updated.configRuleArn).toBe(rule.configRuleArn);

        const afterUpdate = yield* findRule(rule.configRuleName);
        expect(afterUpdate?.Description).toBe(
          "buckets must have versioning enabled (v2)",
        );
        const updatedTags = yield* config
          .listTagsForResource({ ResourceArn: rule.configRuleArn })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
            ),
          );
        expect(updatedTags.Environment).toBe("prod");

        // Renaming replaces the rule.
        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              configRuleName: "alchemy-test-config-rule-renamed",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
            });
          }),
        );
        expect(renamed.configRuleName).toBe("alchemy-test-config-rule-renamed");
        expect(renamed.configRuleArn).not.toBe(rule.configRuleArn);
        yield* assertRuleDeleting(rule.configRuleName);

        yield* stack.destroy();
        yield* assertRuleDeleting(renamed.configRuleName);
      }).pipe(Effect.ensuring(removeRecorderIfCreated(createdRecorder)));
    }),
  { timeout: 120_000 },
);
