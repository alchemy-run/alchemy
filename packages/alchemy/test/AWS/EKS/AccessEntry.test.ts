import * as AWS from "@/AWS";
import { AccessEntry } from "@/AWS/EKS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every EKS access entry across every
// cluster in the account/region. It walks `listClusters` (paginated), then
// `listAccessEntries` per cluster (paginated), and hydrates each via
// `describeAccessEntry` + `listAssociatedAccessPolicies` into the same
// Attributes shape `read` returns. We don't deploy here because a fresh EKS
// cluster takes 10+ minutes to provision (see the gated test below) — but this
// still verifies the cluster-fan-out + pagination + mapping against the live
// API and asserts every returned row is well-formed (the array is empty when
// the account has no clusters).
test.provider("list returns the account/region access entries", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AccessEntry);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const entry of all) {
      expect(typeof entry.accessEntryArn).toBe("string");
      expect(typeof entry.clusterName).toBe("string");
      expect(typeof entry.principalArn).toBe("string");
      expect(Array.isArray(entry.kubernetesGroups)).toBe(true);
      expect(Array.isArray(entry.accessPolicies)).toBe(true);
      expect(entry.tags).toBeDefined();
    }
  }),
);

// Full deploy-then-list assertion. SKIPPED by default because an EKS cluster
// takes 10+ minutes to create (and requires a VPC + subnets + cluster IAM
// role), which exceeds the CI budget. Set AWS_TEST_EKS_CLUSTER to the name of a
// pre-provisioned cluster to run it on an entitled account unchanged. A
// throwaway IAM role is created out-of-band to serve as the access entry's
// principal.
const clusterName = process.env.AWS_TEST_EKS_CLUSTER;

const principalRoleName = "alchemy-test-eks-accessentry-list-principal";

test.provider.skipIf(!clusterName)(
  "list enumerates the deployed access entry",
  (stack) =>
    Effect.gen(function* () {
      const cleanup = Effect.gen(function* () {
        yield* iam
          .deleteRole({ RoleName: principalRoleName })
          .pipe(Effect.catch(() => Effect.void));
      });

      yield* stack.destroy();
      yield* cleanup;

      yield* Effect.gen(function* () {
        const role = yield* iam.createRole({
          RoleName: principalRoleName,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* AccessEntry("ListAccessEntry", {
              clusterName: clusterName!,
              principalArn: role.Role.Arn,
            });
          }),
        );

        const provider = yield* Provider.findProvider(AccessEntry);
        const all = yield* provider.list();

        expect(
          all.some((entry) => entry.accessEntryArn === deployed.accessEntryArn),
        ).toBe(true);

        yield* stack.destroy();
      }).pipe(Effect.ensuring(cleanup));
    }),
  { timeout: 240_000 },
);
