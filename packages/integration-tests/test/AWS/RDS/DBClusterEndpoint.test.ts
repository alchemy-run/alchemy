import * as AWS from "@alchemy.run/aws";
import { DBClusterEndpoint } from "@alchemy.run/aws/RDS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { interruptDestroy } from "../../interruptDestroy.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` path (default): resolve the provider from context via the
// typed `Provider.findProvider`, call `list()`, and assert a well-typed
// `Attributes[]` is returned. No deploy — spinning up an Aurora cluster + custom
// endpoint takes many minutes, far beyond the 240s budget. The account likely
// has zero custom cluster endpoints, so the array is typically empty; we only
// assert shape correctness here.
test.provider(
  "list returns typed custom cluster endpoints",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(DBClusterEndpoint);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const endpoint of all) {
        expect(typeof endpoint.dbClusterEndpointIdentifier).toBe("string");
        expect(Array.isArray(endpoint.staticMembers)).toBe(true);
        expect(Array.isArray(endpoint.excludedMembers)).toBe(true);
        expect(typeof endpoint.tags).toBe("object");
      }
    }),
  { tags: ["provider:aws", "provider:aws:rds", "live"] },
);

// Full deploy-based `list()` verification, gated behind an env var because
// provisioning an Aurora DB cluster and a custom endpoint takes many minutes.
// Run with AWS_TEST_RDS_DBCLUSTER_ENDPOINT=1 on an account willing to pay the
// provisioning cost.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER_ENDPOINT)(
  "list enumerates the deployed custom cluster endpoint, then destroy through an interruption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const endpoint = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.RDS.DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
          });
          return yield* DBClusterEndpoint("ListEndpoint", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            endpointType: "READER",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBClusterEndpoint);
      const all = yield* provider.list();

      expect(
        all.some((e) => e.dbClusterEndpointIdentifier === endpoint.dbClusterEndpointIdentifier),
      ).toBe(true);

      // The destroy is interrupted while the endpoint is deleting. RDS
      // rejects a second delete of it, so the next destroy has to wait for
      // the one already running.
      yield* interruptDestroy(stack, {
        status: rds
          .describeDBClusterEndpoints({
            DBClusterEndpointIdentifier: endpoint.dbClusterEndpointIdentifier,
          })
          .pipe(Effect.map((response) => response.DBClusterEndpoints?.[0]?.Status)),
        deleting: "deleting",
        spaced: "1 second",
      });
      yield* stack.destroy();

      const remaining = yield* rds.describeDBClusterEndpoints({
        DBClusterEndpointIdentifier: endpoint.dbClusterEndpointIdentifier,
      });
      expect(remaining.DBClusterEndpoints ?? []).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:aws:rds", "live"], timeout: 1_800_000 },
);
