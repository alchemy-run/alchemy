import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster, FargateProfile } from "@alchemy.run/aws/EKS";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: `describeFargateProfile` against a cluster that
// does not exist must surface the `ResourceNotFoundException` tag that the
// provider's read/reconcile/delete paths catch. Proves the distilled error
// union without needing a ~10-minute EKS cluster.
test.provider(
  "describeFargateProfile on a nonexistent cluster fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        eks.describeFargateProfile({
          clusterName: "alchemy-nonexistent-cluster-probe",
          fargateProfileName: "alchemy-nonexistent-profile-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Ungated `list()` probe: enumerates every cluster, lists each cluster's Fargate
// profiles, then hydrates each via `describeFargateProfile`. Returns `[]` in a
// clean account/region, otherwise a well-formed array of full FargateProfile
// Attributes. Proves the enumeration wiring compiles and runs live.
test.provider(
  "list returns a well-formed array of Fargate profiles",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(FargateProfile);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const profile of all) {
        expect(typeof profile.fargateProfileArn).toBe("string");
        expect(typeof profile.fargateProfileName).toBe("string");
        expect(typeof profile.clusterName).toBe("string");
        expect(typeof profile.podExecutionRoleArn).toBe("string");
        expect(Array.isArray(profile.subnets)).toBe(true);
        expect(Array.isArray(profile.selectors)).toBe(true);
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

const clusterTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "eks.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const podExecutionTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "eks-fargate-pods.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// Full deploy lifecycle on its own cluster (~10 min create, ~5 min delete), so
// it skips under `--fast`. Fargate pods reject public subnets, so the profile
// uses the network's private subnets. Deploys a profile, replaces it with a
// new selector, then tears down and asserts both are gone.
test.provider.skipIf(!!process.env.FAST)(
  "creates, replaces, and deletes a Fargate profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (namespace: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("FargateNetwork", {
              cidrBlock: "10.89.0.0/16",
              availabilityZones: 2,
            });
            const clusterRole = yield* Role("FargateClusterRole", {
              assumeRolePolicyDocument: clusterTrustPolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"],
            });
            const podExecutionRole = yield* Role("FargatePodExecutionRole", {
              assumeRolePolicyDocument: podExecutionTrustPolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy"],
            });
            const cluster = yield* Cluster("FargateCluster", {
              roleArn: clusterRole.roleArn,
              resourcesVpcConfig: {
                subnetIds: network.privateSubnetIds,
                endpointPublicAccess: true,
              },
              accessConfig: { authenticationMode: "API" },
            });
            return yield* FargateProfile("TestFargateProfile", {
              clusterName: cluster.clusterName,
              podExecutionRoleArn: podExecutionRole.roleArn,
              subnets: network.privateSubnetIds,
              selectors: [{ namespace }],
            });
          }),
        );

      const exists = (profile: FargateProfile["Attributes"]) =>
        eks
          .describeFargateProfile({
            clusterName: profile.clusterName,
            fargateProfileName: profile.fargateProfileName,
          })
          .pipe(
            Effect.map((response) => response.fargateProfile?.status),
            Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
          );

      const created = yield* deploy("alchemy-fargate-test");
      expect(created.status).toBe("ACTIVE");
      expect(created.selectors[0]?.namespace).toBe("alchemy-fargate-test");

      // Selectors are immutable, so a new selector replaces the profile.
      const replaced = yield* deploy("alchemy-fargate-test-2");
      expect(replaced.status).toBe("ACTIVE");
      expect(replaced.selectors[0]?.namespace).toBe("alchemy-fargate-test-2");
      expect(replaced.fargateProfileArn).not.toBe(created.fargateProfileArn);
      expect(yield* exists(replaced)).toBe("ACTIVE");

      yield* stack.destroy();

      expect(yield* exists(created)).toBeUndefined();
      expect(yield* exists(replaced)).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 2_700_000 },
);
