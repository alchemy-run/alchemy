import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "westus2";

const getBinding = (
  resourceGroupName: string,
  resourceName: string,
  identityBindingName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetIdentityBinding({
      subscriptionId,
      resourceGroupName,
      resourceName,
      identityBindingName,
    });
  });

const program = (withBinding: boolean) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster(location, {
      oidcIssuerEnabled: true,
      workloadIdentityEnabled: true,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName, location },
    );
    const binding = withBinding
      ? yield* Azure.ContainerService.IdentityBinding("Binding", {
          resourceGroup: group.resourceGroupName,
          cluster: cluster.clusterName,
          managedIdentityId: identity.identityId,
        })
      : undefined;
    return { group, cluster, identity, binding };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03), a free user-assigned
// identity, and the binding (~1 min). The binding has no mutable property.
test.provider(
  "create and delete an identity binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(true));
      const { group, cluster, identity } = created;
      const binding = created.binding!;
      expect(binding.managedIdentityId.toLowerCase()).toEqual(
        identity.identityId.toLowerCase(),
      );
      expect(binding.clientId).toEqual(identity.clientId);
      const observed = yield* getBinding(
        group.resourceGroupName,
        cluster.clusterName,
        binding.bindingName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.oidcIssuer?.oidcIssuerUrl).toContain(
        "https://",
      );

      // Removing the binding deletes it while the cluster stays.
      yield* stack.deploy(program(false));
      expect(
        yield* untilGone(
          getBinding(
            group.resourceGroupName,
            cluster.clusterName,
            binding.bindingName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
