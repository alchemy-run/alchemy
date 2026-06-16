import * as AWS from "@/AWS";
import { DBCluster, DBInstance } from "@/AWS/RDS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Default (read-only) path: an RDS instance takes many minutes to create and
// delete — far beyond the 240s test budget — so the canonical `list()` test
// here does NOT deploy. It resolves the provider via the typed
// `Provider.findProvider(DBInstance)` helper and calls `list()` directly,
// asserting it returns a well-typed `DBInstance["Attributes"][]`. On a fresh
// account this is typically empty; either way every element must conform to
// the exact `read` shape.
test.provider("list returns well-typed DB instance attributes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBInstance);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    // Every element must match the exact `Attributes` shape `read` produces.
    for (const instance of all) {
      expect(typeof instance.dbInstanceIdentifier).toBe("string");
      expect(typeof instance.dbInstanceArn).toBe("string");
      expect(Array.isArray(instance.dbParameterGroupNames)).toBe(true);
      expect(typeof instance.tags).toBe("object");
    }
  }),
);

// Full lifecycle is gated: provisioning an Aurora cluster + instance and then
// tearing it down takes many minutes, exceeding the 240s budget. Set
// AWS_TEST_RDS_DBINSTANCE=1 on an account that can afford the wait to run it.
// It deploys a serverless-v2 Aurora cluster + instance and asserts the
// instance appears in the exhaustively-paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBINSTANCE)(
  "list enumerates the deployed DB instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });

          return yield* DBInstance("ListInstance", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbInstanceClass: "db.serverless",
            engine: "aurora-postgresql",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBInstance);
      const all = yield* provider.list();

      expect(
        all.some(
          (i) => i.dbInstanceIdentifier === instance.dbInstanceIdentifier,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);
