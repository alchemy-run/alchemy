import * as AWS from "@/AWS";
import { Config } from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Vitest";
import * as config from "@distilled.cloud/aws/config-service";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic out-of-band names (no Date.now — stable across re-runs).
const bucketName = "alchemy-test-config-bucket";
const roleName = "alchemy-test-config-role";
const recorderName = "alchemy-test-config-recorder";
const channelName = "alchemy-test-config-channel";
const ruleName = "alchemy-test-config-rule";

// AWS Config requires the destination bucket to authorize config.amazonaws.com
// to check the ACL/existence and write configuration snapshots.
const configBucketPolicy = (accountId: string) => {
  const bucketArn = `arn:aws:s3:::${bucketName}`;
  return [
    {
      Sid: "AWSConfigBucketPermissionsCheck",
      Effect: "Allow" as const,
      Principal: { Service: "config.amazonaws.com" },
      Action: ["s3:GetBucketAcl", "s3:ListBucket"],
      Resource: [bucketArn],
    },
    {
      Sid: "AWSConfigBucketDelivery",
      Effect: "Allow" as const,
      Principal: { Service: "config.amazonaws.com" },
      Action: ["s3:PutObject"],
      Resource: [`${bucketArn}/AWSLogs/${accountId}/Config/*`],
      Condition: {
        StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" },
      },
    },
  ];
};

const configRoleTrust = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "config.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// AWS Config allows exactly one customer-managed configuration recorder and one
// delivery channel per account/region. Capture whatever exists before the test
// and restore it afterward so we never clobber a real recorder. Because these
// are account singletons, this file's tests must not run concurrently with any
// other Config-mutating test — this is the only such file.
test.provider(
  "recorder + delivery channel + managed rule capture-and-restore",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;

      // CAPTURE the existing singletons (typically none in a test account).
      const existingRecorders = yield* config
        .describeConfigurationRecorders({})
        .pipe(
          Effect.map((r) => r.ConfigurationRecorders ?? []),
          Effect.catchTag("NoSuchConfigurationRecorderException", () =>
            Effect.succeed([] as config.ConfigurationRecorder[]),
          ),
        );
      const existingChannels = yield* config.describeDeliveryChannels({}).pipe(
        Effect.map((r) => r.DeliveryChannels ?? []),
        Effect.catchTag("NoSuchDeliveryChannelException", () =>
          Effect.succeed([] as config.DeliveryChannel[]),
        ),
      );

      // Restore captured singletons on the way out, whatever happens in-between.
      const restore = Effect.gen(function* () {
        for (const rec of existingRecorders) {
          yield* config
            .putConfigurationRecorder({ ConfigurationRecorder: rec })
            .pipe(Effect.catch(() => Effect.void));
        }
        for (const ch of existingChannels) {
          yield* config
            .putDeliveryChannel({ DeliveryChannel: ch })
            .pipe(Effect.catch(() => Effect.void));
        }
      });

      const body = Effect.gen(function* () {
        yield* stack.destroy();

        // Free the singleton slot if a foreign recorder/channel exists (it is
        // restored in `restore`). Stop then delete so it is removable.
        for (const rec of existingRecorders) {
          if (!rec.name) continue;
          yield* config
            .stopConfigurationRecorder({ ConfigurationRecorderName: rec.name })
            .pipe(Effect.catch(() => Effect.void));
        }
        for (const ch of existingChannels) {
          if (!ch.name) continue;
          yield* config
            .deleteDeliveryChannel({ DeliveryChannelName: ch.name })
            .pipe(Effect.catch(() => Effect.void));
        }
        for (const rec of existingRecorders) {
          if (!rec.name) continue;
          yield* config
            .deleteConfigurationRecorder({
              ConfigurationRecorderName: rec.name,
            })
            .pipe(Effect.catch(() => Effect.void));
        }

        const { recorder, channel, rule } = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("ConfigBucket", {
              bucketName,
              forceDestroy: true,
              policy: configBucketPolicy(accountId),
            });
            const role = yield* Role("ConfigRole", {
              roleName,
              assumeRolePolicyDocument: configRoleTrust,
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole",
              ],
            });
            const channel = yield* Config.DeliveryChannel("Channel", {
              channelName,
              s3BucketName: bucket.bucketName,
            });
            const recorder = yield* Config.ConfigurationRecorder("Recorder", {
              recorderName,
              roleArn: role.roleArn,
              recordingGroup: { allSupported: true },
            });
            const rule = yield* Config.ConfigRule("Rule", {
              configRuleName: ruleName,
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_PUBLIC_READ_PROHIBITED",
              },
            });
            return { recorder, channel, rule };
          }),
        );

        expect(recorder.recorderName).toEqual(recorderName);
        expect(channel.channelName).toEqual(channelName);
        expect(rule.configRuleName).toEqual(ruleName);
        expect(rule.configRuleArn).toContain(":config-rule/");

        // Out-of-band: both singletons exist.
        const recorders = yield* config.describeConfigurationRecorders({
          ConfigurationRecorderNames: [recorderName],
        });
        expect(recorders.ConfigurationRecorders?.[0]?.name).toEqual(
          recorderName,
        );
        const channels = yield* config.describeDeliveryChannels({
          DeliveryChannelNames: [channelName],
        });
        expect(channels.DeliveryChannels?.[0]?.s3BucketName).toEqual(
          bucketName,
        );

        // Out-of-band: the managed rule exists and is ACTIVE (evaluation
        // COMPLIANT/NON_COMPLIANT is out of scope — we only assert it is live).
        const rules = yield* config.describeConfigRules({
          ConfigRuleNames: [ruleName],
        });
        expect(rules.ConfigRules?.[0]?.ConfigRuleState).toEqual("ACTIVE");
        expect(rules.ConfigRules?.[0]?.Source?.SourceIdentifier).toEqual(
          "S3_BUCKET_PUBLIC_READ_PROHIBITED",
        );

        yield* stack.destroy();

        // Out-of-band: the recorder is gone.
        const gone = yield* config
          .describeConfigurationRecorders({
            ConfigurationRecorderNames: [recorderName],
          })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("NoSuchConfigurationRecorderException", () =>
              Effect.succeed(true),
            ),
            Effect.retry({
              schedule: Schedule.spaced("1 seconds"),
              until: (isGone) => isGone === true,
              times: 8,
            }),
          );
        expect(gone).toBe(true);
      });

      yield* body.pipe(Effect.ensuring(restore));
    }),
  { timeout: 240_000 },
);
