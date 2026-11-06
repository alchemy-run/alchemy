import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster } from "@alchemy.run/aws/EKS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probe: `list()` enumerates every cluster in the ambient
// account/region by paginating `listClusters` (names only) and hydrating each
// via `readCluster` (describeCluster + listTagsForResource). It needs no
// deployed resource — in a clean account/region it returns `[]`, otherwise a
// well-formed array of full Cluster Attributes. This proves the enumeration
// wiring (listClusters -> describeCluster) compiles and runs live without
// paying the ~10-minute control-plane create.
test.provider(
  "list returns a well-formed array of clusters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cluster);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const cluster of all) {
        expect(typeof cluster.clusterArn).toBe("string");
        expect(typeof cluster.clusterName).toBe("string");
        expect(typeof cluster.roleArn).toBe("string");
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Full deploy test: an EKS control plane takes ~10+ minutes to provision, far
// too heavy for CI. Gate the deploy behind env vars supplying a pre-existing
// IAM role ARN (AWS_TEST_EKS_ROLE_ARN) and at least two subnet IDs
// (AWS_TEST_EKS_SUBNET_IDS, comma-separated). An account with that standing
// infrastructure runs this unchanged: it deploys a cluster, waits for ACTIVE,
// asserts it appears in the exhaustively-paginated `list()`, then tears down.
test.provider.skipIf(!process.env.AWS_TEST_EKS_ROLE_ARN || !process.env.AWS_TEST_EKS_SUBNET_IDS)(
  "list enumerates the deployed cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleArn = process.env.AWS_TEST_EKS_ROLE_ARN!;
      const subnetIds = process.env.AWS_TEST_EKS_SUBNET_IDS!.split(",");

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("ListCluster", {
            clusterName: "alchemy-test-eks-list",
            roleArn,
            resourcesVpcConfig: {
              subnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cluster);
      const all = yield* provider.list();

      expect(all.some((c) => c.clusterName === cluster.clusterName)).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 1_800_000 },
);

// Regression: every config update of one category sent the same
// clientRequestToken, so EKS answered the second logging change as a retry of
// the first and left logging unchanged. Provisions its own Auto Mode cluster
// (~10 min create, ~5 min delete), so it skips under `--fast`.
test.provider.skipIf(!!process.env.FAST)(
  "applies every logging update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (enabled: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("LoggingNetwork", {
              cidrBlock: "10.87.0.0/16",
              availabilityZones: 2,
            });
            return yield* Cluster("LoggingCluster", {
              compute: "auto",
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
              logging: { clusterLogging: [{ types: ["api"], enabled }] },
            });
          }),
        );

      const apiLogging = (cluster: Cluster["Attributes"]) =>
        eks
          .describeCluster({ name: cluster.clusterName })
          .pipe(
            Effect.map((response) =>
              (response.cluster?.logging?.clusterLogging ?? []).some(
                (setup) => setup.enabled === true && (setup.types ?? []).includes("api"),
              ),
            ),
          );

      const created = yield* deploy(false);
      expect(yield* apiLogging(created)).toBe(false);

      const enabled = yield* deploy(true);
      expect(yield* apiLogging(enabled)).toBe(true);

      const disabled = yield* deploy(false);
      expect(yield* apiLogging(disabled)).toBe(false);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 2_400_000 },
);
