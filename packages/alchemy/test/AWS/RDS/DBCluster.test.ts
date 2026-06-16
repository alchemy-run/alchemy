import * as AWS from "@/AWS";
import { DBCluster } from "@/AWS/RDS/DBCluster.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` test (no deploy). An Aurora DB cluster takes MANY minutes
// to create *and* delete — far beyond the 240s test budget — so we exercise the
// enumeration path without provisioning. We resolve the provider via the typed
// `Provider.findProvider(DBCluster)` so `list()`'s element type is the exact
// `DBCluster["Attributes"]` shape, call it, and assert it returns a well-typed
// array (likely empty in a clean test account). This proves the paginated
// `describeDBClusters` -> Attributes mapping compiles and runs.
test.provider("list returns a typed DBCluster Attributes array", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBCluster);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const cluster of all) {
      expect(typeof cluster.dbClusterIdentifier).toBe("string");
      expect(typeof cluster.dbClusterArn).toBe("string");
      expect(typeof cluster.engine).toBe("string");
      expect(typeof cluster.tags).toBe("object");
      expect(Array.isArray(cluster.vpcSecurityGroupIds)).toBe(true);
    }
  }),
);

// Full deploy-based `list()` test, gated behind AWS_TEST_RDS_DBCLUSTER=1.
// Reason: an Aurora cluster create + delete spans many minutes, blowing past
// the 240s budget, so it is opt-in only. When enabled, it deploys a real
// cluster and asserts the deployed identifier appears in the exhaustively
// paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER)(
  "list enumerates the deployed DB cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBCluster);
      const all = yield* provider.list();

      expect(
        all.some((c) => c.dbClusterIdentifier === cluster.dbClusterIdentifier),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);
