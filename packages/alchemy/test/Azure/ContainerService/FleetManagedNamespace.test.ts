import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "northcentralus";

const getNamespace = (
  resourceGroupName: string,
  fleetName: string,
  managedNamespaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetFleetManagedNamespace({
      subscriptionId,
      resourceGroupName,
      fleetName,
      managedNamespaceName,
    });
  });

const program = (props: { team: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    // Fleet managed namespaces live on the fleet's hub cluster.
    const fleet = yield* Azure.ContainerService.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      location,
      hubProfile: { agentVmSize: "Standard_D2s_v7" },
    });
    const namespace = yield* Azure.ContainerService.FleetManagedNamespace(
      "Namespace",
      {
        resourceGroup: group.resourceGroupName,
        fleet: fleet.fleetName,
        labels: { team: props.team },
        defaultResourceQuota: {
          cpuRequest: "500m",
          cpuLimit: "2000m",
          memoryRequest: "256Mi",
          memoryLimit: "1Gi",
        },
        tags: props.tags,
      },
    );
    return { group, fleet, namespace };
  });

// A fleet hub is a managed AKS cluster (one 2-vCPU node, ~$0.10/h) that
// takes 10-15 minutes to provision and ~10 minutes to delete: over the time
// budget. Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a fleet managed namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ team: "a", tags: { env: "test" } }),
      );
      const { group, fleet, namespace } = created;
      expect(fleet.hasHub).toEqual(true);
      const observed = yield* getNamespace(
        group.resourceGroupName,
        fleet.fleetName,
        namespace.namespaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.managedNamespaceProperties?.labels?.team,
      ).toEqual("a");

      const updated = yield* stack.deploy(
        program({ team: "b", tags: { env: "prod" } }),
      );
      expect(updated.namespace.namespaceName).toEqual(namespace.namespaceName);
      expect(updated.namespace.tags).toEqual({ env: "prod" });
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        fleet.fleetName,
        namespace.namespaceName,
      );
      expect(
        reobserved.properties?.managedNamespaceProperties?.labels?.team,
      ).toEqual("b");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNamespace(
            group.resourceGroupName,
            fleet.fleetName,
            namespace.namespaceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
