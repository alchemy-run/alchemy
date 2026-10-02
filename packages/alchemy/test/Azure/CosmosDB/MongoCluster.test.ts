import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { logLevel, waitGone } from "./helpers.ts";
import { getCluster, MONGO_LOCATION, mongoTags, testCluster } from "./mongo.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: Partial<Azure.CosmosDB.MongoClusterProps>) =>
  testCluster({ computeTier: "Free", ...props });

// One Free-tier cluster ($0); 7-25 min to create, ~3 min to delete.
// Cluster provisioning regularly exceeds 10 minutes, so this runs only
// with AZURE_TEST_EXPENSIVE=1. Changing the name would replace it
// create-first, which needs a second Free cluster (one per subscription),
// so replacement is not exercised live.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a mongo (vCore) cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ tags: { env: "test" }, authModes: ["NativeAuth"] }),
      );
      expect(cluster.location).toEqual(MONGO_LOCATION);
      expect(cluster.computeTier).toEqual("Free");
      expect(cluster.tags).toEqual({ env: "test" });
      expect(cluster.administratorUserName).toEqual("alchemyadmin");
      expect(cluster.administratorPassword).toBeDefined();
      const connection = Redacted.value(cluster.connectionString!);
      expect(connection).toMatch(/^mongodb\+srv:\/\/alchemyadmin:/);
      expect(connection).not.toContain("<password>");
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.mongoClusterName,
      );
      expect(observed.id).toEqual(cluster.mongoClusterId);
      expect(observed.properties?.compute?.tier).toEqual("Free");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cluster");

      // In-place update: tags and the administrator password. (Entra ID
      // auth is not available on the Free tier.)
      const password = Redacted.make("Rotated-Passw0rd-1234");
      const updated = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          authModes: ["NativeAuth"],
          administratorPassword: password,
        }),
      );
      expect(updated.cluster.mongoClusterId).toEqual(cluster.mongoClusterId);
      expect(Redacted.value(updated.cluster.connectionString!)).toContain(
        ":Rotated-Passw0rd-1234@",
      );
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.mongoClusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, cluster.mongoClusterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: mongoTags, timeout: 900_000 },
);
