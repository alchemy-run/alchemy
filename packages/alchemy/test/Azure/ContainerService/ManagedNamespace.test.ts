import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "southcentralus";

const getNamespace = (
  resourceGroupName: string,
  resourceName: string,
  managedNamespaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetManagedNamespace({
      subscriptionId,
      resourceGroupName,
      resourceName,
      managedNamespaceName,
    });
  });

const program = (props: {
  team: string;
  cpuRequest: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // Managed namespaces need Entra ID with Azure RBAC for Kubernetes.
    const { group, cluster } = yield* testCluster(location, {
      aad: { enableAzureRbac: true },
    });
    const namespace = yield* Azure.ContainerService.ManagedNamespace(
      "Namespace",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.clusterName,
        labels: { team: props.team },
        defaultResourceQuota: {
          cpuRequest: props.cpuRequest,
          cpuLimit: "2000m",
          memoryRequest: "256Mi",
          memoryLimit: "1Gi",
        },
        defaultNetworkPolicy: {
          ingress: "AllowSameNamespace",
          egress: "AllowAll",
        },
        tags: props.tags,
      },
    );
    return { group, cluster, namespace };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03) plus the namespace
// (~1 min per step, free).
test.provider(
  "create, update, and delete a managed namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ team: "a", cpuRequest: "500m", tags: { env: "test" } }),
      );
      const { group, cluster, namespace } = created;
      expect(namespace.namespaceId).toContain("/managedNamespaces/");
      const observed = yield* getNamespace(
        group.resourceGroupName,
        cluster.clusterName,
        namespace.namespaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.labels?.team).toEqual("a");
      expect(observed.properties?.defaultResourceQuota?.cpuRequest).toEqual(
        "500m",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Namespace");

      const updated = yield* stack.deploy(
        program({ team: "b", cpuRequest: "1000m", tags: { env: "prod" } }),
      );
      expect(updated.namespace.namespaceName).toEqual(namespace.namespaceName);
      expect(updated.namespace.tags).toEqual({ env: "prod" });
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        cluster.clusterName,
        namespace.namespaceName,
      );
      expect(reobserved.properties?.labels?.team).toEqual("b");
      expect(reobserved.properties?.defaultResourceQuota?.cpuRequest).toEqual(
        "1000m",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getNamespace(
            group.resourceGroupName,
            cluster.clusterName,
            namespace.namespaceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
