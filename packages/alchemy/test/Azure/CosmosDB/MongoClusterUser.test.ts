import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, waitGone } from "./helpers.ts";
import { clusterRef, mongoTags, testCluster } from "./mongo.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Both identities stay deployed across the replacement step.
const program = (props: { principal: "A" | "B" }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster({
      authModes: ["NativeAuth", "MicrosoftEntraID"],
    });
    const a = yield* Azure.ManagedIdentity.UserAssignedIdentity("IdentityA", {
      resourceGroup: group.resourceGroupName,
      location: cluster.location,
    });
    const b = yield* Azure.ManagedIdentity.UserAssignedIdentity("IdentityB", {
      resourceGroup: group.resourceGroupName,
      location: cluster.location,
    });
    const user = yield* Azure.CosmosDB.MongoClusterUser("App", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.mongoClusterName,
      principalId: props.principal === "A" ? a.principalId : b.principalId,
      principalType: "servicePrincipal",
    });
    return { group, cluster, a, b, user };
  });

const getUser = (
  resourceGroupName: string,
  mongoClusterName: string,
  userName: string,
) =>
  Effect.flatMap(clusterRef(resourceGroupName, mongoClusterName), (ref) =>
    mongocluster.GetUser({ ...ref, userName }),
  );

// One M10 cluster with Entra ID auth (≈ $0.10/h, 7-25 min to create and
// delete) — a few cents. The only built-in role is `admin/root`, so there
// is no in-place role update to exercise. Cluster provisioning regularly
// exceeds 10 minutes, so this runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a mongo cluster Entra ID user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, a, b, user } = yield* stack.deploy(
        program({ principal: "A" }),
      );
      expect(user.userName).toEqual(a.principalId);
      expect(user.roles).toEqual([{ db: "admin", role: "root" }]);
      const observed = yield* getUser(
        group.resourceGroupName,
        cluster.mongoClusterName,
        a.principalId,
      );
      expect(observed.id).toEqual(user.userId);
      expect(observed.properties?.identityProvider?.type).toEqual(
        "MicrosoftEntraID",
      );
      expect(
        observed.properties?.identityProvider?.properties?.principalType,
      ).toEqual("servicePrincipal");

      // A different principal replaces the user.
      const replaced = yield* stack.deploy(program({ principal: "B" }));
      expect(replaced.user.userName).toEqual(b.principalId);
      const observedB = yield* getUser(
        group.resourceGroupName,
        cluster.mongoClusterName,
        b.principalId,
      );
      expect(observedB.properties?.roles).toEqual([
        { db: "admin", role: "root" },
      ]);
      expect(
        yield* waitGone(
          getUser(
            group.resourceGroupName,
            cluster.mongoClusterName,
            a.principalId,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getUser(
            group.resourceGroupName,
            cluster.mongoClusterName,
            b.principalId,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: mongoTags, timeout: 900_000 },
);
