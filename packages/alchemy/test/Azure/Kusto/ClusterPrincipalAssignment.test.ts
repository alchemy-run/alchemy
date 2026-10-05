import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssignment = (
  resourceGroupName: string,
  clusterName: string,
  principalAssignmentName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetClusterPrincipalAssignment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      principalAssignmentName,
    });
  });

const program = (props: {
  identity: "Reader" | "Monitor";
  role: Azure.Kusto.KustoClusterPrincipalRole;
}) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster();
    // Both identities stay deployed across the replacement step.
    const reader = yield* Azure.ManagedIdentity.UserAssignedIdentity("Reader", {
      resourceGroup: group.resourceGroupName,
    });
    const monitor = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Monitor",
      { resourceGroup: group.resourceGroupName },
    );
    const identity = props.identity === "Reader" ? reader : monitor;
    const assignment = yield* Azure.Kusto.ClusterPrincipalAssignment(
      "Assignment",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.clusterName,
        principalId: identity.clientId,
        principalType: "App",
        tenantId: identity.tenantId,
        role: props.role,
      },
    );
    return { group, cluster, identity, assignment };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10
// to delete): ~$0.20 per run, ~30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a Kusto cluster principal assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, identity, assignment } = yield* stack.deploy(
        program({ identity: "Reader", role: "AllDatabasesViewer" }),
      );
      const get = (name: string) =>
        getAssignment(group.resourceGroupName, cluster.clusterName, name);
      const observed = yield* get(assignment.principalAssignmentName);
      expect(observed.properties?.role).toEqual("AllDatabasesViewer");
      expect(observed.properties?.principalId).toEqual(identity.clientId);

      // In place: change the role.
      const updated = yield* stack.deploy(
        program({ identity: "Reader", role: "AllDatabasesMonitor" }),
      );
      expect(updated.assignment.principalAssignmentId).toEqual(
        assignment.principalAssignmentId,
      );
      expect(
        (yield* get(assignment.principalAssignmentName)).properties?.role,
      ).toEqual("AllDatabasesMonitor");

      // Replacement: a different principal.
      const replaced = yield* stack.deploy(
        program({ identity: "Monitor", role: "AllDatabasesMonitor" }),
      );
      const reobserved = yield* get(
        replaced.assignment.principalAssignmentName,
      );
      expect(reobserved.properties?.principalId).toEqual(
        replaced.identity.clientId,
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.assignment.principalAssignmentName), 60),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
