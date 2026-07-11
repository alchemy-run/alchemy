import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { AwsLogSource, DataLake, Subscriber } from "@/AWS/SecurityLake";
import * as Test from "@/Test/Vitest";
import * as securitylake from "@distilled.cloud/aws/securitylake";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// ---------------------------------------------------------------------------
// Ungated typed-error probes: prove the distilled error union carries the tags
// the providers' read/delete paths depend on, at near-zero cost. Security Lake
// lifecycle itself is account-wide and heavy, so it is gated below.
// ---------------------------------------------------------------------------

test.provider(
  "getSubscriber on a nonexistent subscriber fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        securitylake.getSubscriber({
          // valid UUID shape, never allocated
          subscriberId: "00000000-0000-4000-8000-000000000000",
        }),
      );
      // Onboarded accounts return ResourceNotFoundException; accounts that
      // never enabled Security Lake reject every subscriber API with the
      // (patched-in) UnauthorizedException wire error.
      expect(["ResourceNotFoundException", "UnauthorizedException"]).toContain(
        error._tag,
      );
    }),
);

test.provider(
  "listDataLakes returns data lakes or a typed not-onboarded rejection",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(securitylake.listDataLakes({}));
      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.dataLakes ?? [])).toBe(true);
      } else {
        // Accounts that never onboarded Security Lake reject listDataLakes
        // with AccessDeniedException.
        expect(result.failure._tag).toBe("AccessDeniedException");
      }
    }),
);

// ---------------------------------------------------------------------------
// Gated live lifecycle. Enabling Security Lake onboards the whole account in
// the Region: it creates S3 buckets, registers them with Lake Formation, and
// configures the Glue metastore. The buckets are retained after delete (AWS
// behavior). Run with AWS_TEST_SECURITYLAKE=1 on an account you are willing to
// onboard/offboard.
// ---------------------------------------------------------------------------

const assertDataLakeGone = securitylake.listDataLakes({}).pipe(
  Effect.flatMap((response) =>
    (response.dataLakes ?? []).length === 0
      ? Effect.void
      : Effect.fail(new Error("data lake still present")),
  ),
  Effect.retry({
    schedule: Schedule.fixed("5 seconds").pipe(
      Schedule.both(Schedule.recurs(12)),
    ),
  }),
);

test.provider.skipIf(!process.env.AWS_TEST_SECURITYLAKE)(
  "lifecycle: enable data lake, add ROUTE53 source + subscriber, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWS.AWSEnvironment.current;

      // Never stomp an existing Security Lake deployment.
      const preexisting = yield* securitylake.listDataLakes({});
      if ((preexisting.dataLakes ?? []).length > 0) {
        yield* Effect.logInfo(
          "Security Lake already enabled in this account — skipping destructive lifecycle test",
        );
        return;
      }

      yield* stack.destroy();

      const deployOnce = (subscriberDescription: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const metastoreRole = yield* Role("MetastoreRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AmazonSecurityLakeMetastoreManager",
              ],
            });
            const lake = yield* DataLake("Lake", {
              configurations: [
                {
                  region,
                  lifecycleConfiguration: { expiration: { days: 30 } },
                },
              ],
              metaStoreManagerRoleArn: metastoreRole.roleArn,
              tags: { fixture: "securitylake" },
            });
            const source = yield* AwsLogSource("Route53Source", {
              sourceName: "ROUTE53",
              regions: lake.regions,
            });
            const subscriber = yield* Subscriber("Consumer", {
              subscriberIdentity: {
                principal: accountId,
                externalId: "alchemy-securitylake-test",
              },
              subscriberDescription,
              // Reference the log source's output so destroy ordering tears
              // the subscriber down before the source and data lake.
              sources: [{ awsLogSource: { sourceName: source.sourceName } }],
              accessTypes: ["S3"],
              tags: { fixture: "securitylake" },
            });
            return { lake, source, subscriber };
          }),
        );

      // Create.
      const { lake, source, subscriber } = yield* deployOnce("v1");
      expect(lake.dataLakeArn).toContain(":securitylake:");
      expect(lake.regions).toContain(region);
      expect(source.sourceName).toBe("ROUTE53");
      expect(source.regions).toContain(region);
      expect(subscriber.subscriberId).toBeDefined();
      expect(subscriber.s3BucketArn).toBeDefined();

      // Out-of-band verification via distilled.
      const lakes = yield* securitylake.listDataLakes({});
      expect(lakes.dataLakes?.some((l) => l.region === region)).toBe(true);
      const observedSubscriber = yield* securitylake.getSubscriber({
        subscriberId: subscriber.subscriberId,
      });
      expect(observedSubscriber.subscriber?.subscriberArn).toBe(
        subscriber.subscriberArn,
      );

      // Update in place (subscriber description).
      const second = yield* deployOnce("v2");
      expect(second.subscriber.subscriberId).toBe(subscriber.subscriberId);
      const updated = yield* securitylake.getSubscriber({
        subscriberId: subscriber.subscriberId,
      });
      expect(updated.subscriber?.subscriberDescription).toBe("v2");

      // Destroy — offboards the account; buckets are retained by AWS design.
      yield* stack.destroy();
      const goneSubscriber = yield* Effect.flip(
        securitylake.getSubscriber({
          subscriberId: subscriber.subscriberId,
        }),
      );
      expect(goneSubscriber._tag).toBe("ResourceNotFoundException");
      yield* assertDataLakeGone;
    }),
  { timeout: 1_200_000 },
);
