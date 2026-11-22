import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster, Nodegroup } from "@alchemy.run/aws/EKS";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: `describeNodegroup` against a cluster that does not
// exist must surface the `ResourceNotFoundException` tag that the provider's
// read/reconcile/delete paths catch. This proves the distilled error union is
// correct without needing a ~10-minute EKS cluster.
test.provider(
  "describeNodegroup on a nonexistent cluster fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        eks.describeNodegroup({
          clusterName: "alchemy-nonexistent-cluster-probe",
          nodegroupName: "alchemy-nonexistent-nodegroup-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Ungated `list()` probe: enumerates every cluster, lists each cluster's node
// groups, then hydrates each via `describeNodegroup`. Requires no deployed
// resource — returns `[]` in a clean account/region, otherwise a well-formed
// array of full Nodegroup Attributes. Proves the enumeration wiring compiles
// and runs live.
test.provider(
  "list returns a well-formed array of node groups",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Nodegroup);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const nodegroup of all) {
        expect(typeof nodegroup.nodegroupArn).toBe("string");
        expect(typeof nodegroup.nodegroupName).toBe("string");
        expect(typeof nodegroup.clusterName).toBe("string");
        expect(typeof nodegroup.nodeRole).toBe("string");
        expect(Array.isArray(nodegroup.subnets)).toBe(true);
        expect(Array.isArray(nodegroup.instanceTypes)).toBe(true);
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

const nodeTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "ec2.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// Full deploy lifecycle on its own cluster (~10 min create, ~5 min delete), so
// it skips under `--fast`. Deploys a node group, scales it up and back down,
// then tears down and asserts it is gone. Regression: every config update sent
// the same clientRequestToken, so EKS answered the second scale as a retry of
// the first and left the node group at the first scale's size.
test.provider.skipIf(!!process.env.FAST)(
  "creates, scales, and deletes a managed node group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (scalingConfig: { minSize: number; maxSize: number; desiredSize: number }) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("NodegroupNetwork", {
              cidrBlock: "10.88.0.0/16",
              availabilityZones: 2,
            });
            const clusterRole = yield* Role("NodegroupClusterRole", {
              assumeRolePolicyDocument: clusterTrustPolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"],
            });
            const nodeRole = yield* Role("NodegroupNodeRole", {
              assumeRolePolicyDocument: nodeTrustPolicy,
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
                "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
                "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
              ],
            });
            const cluster = yield* Cluster("NodegroupCluster", {
              roleArn: clusterRole.roleArn,
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
              accessConfig: { authenticationMode: "API" },
            });
            return yield* Nodegroup("TestNodegroup", {
              clusterName: cluster.clusterName,
              nodeRole: nodeRole.roleArn,
              subnets: network.publicSubnetIds,
              instanceTypes: ["t3.medium"],
              scalingConfig,
            });
          }),
        );

      const desiredSize = (nodegroup: Nodegroup["Attributes"]) =>
        eks
          .describeNodegroup({
            clusterName: nodegroup.clusterName,
            nodegroupName: nodegroup.nodegroupName,
          })
          .pipe(Effect.map((response) => response.nodegroup?.scalingConfig?.desiredSize));

      const created = yield* deploy({ minSize: 1, maxSize: 2, desiredSize: 1 });
      expect(created.status).toBe("ACTIVE");
      expect(yield* desiredSize(created)).toBe(1);

      const scaled = yield* deploy({ minSize: 1, maxSize: 3, desiredSize: 2 });
      expect(scaled.status).toBe("ACTIVE");
      expect(yield* desiredSize(scaled)).toBe(2);

      const rescaled = yield* deploy({ minSize: 1, maxSize: 3, desiredSize: 1 });
      expect(rescaled.status).toBe("ACTIVE");
      expect(yield* desiredSize(rescaled)).toBe(1);

      yield* stack.destroy();

      const gone = yield* eks
        .describeNodegroup({
          clusterName: created.clusterName,
          nodegroupName: created.nodegroupName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 2_700_000 },
);
