import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "westus3";
const role = "Microsoft.CognitiveServices/accounts/foundry-agent-operator";

const getBinding = (
  resourceGroupName: string,
  resourceName: string,
  trustedAccessRoleBindingName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetTrustedAccessRoleBinding({
      subscriptionId,
      resourceGroupName,
      resourceName,
      trustedAccessRoleBindingName,
    });
  });

const program = (withBinding: boolean) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster(location);
    // An idle AI Services (S0) account costs nothing and is purged on delete.
    const account = yield* Azure.CognitiveServices.Account("Foundry", {
      resourceGroup: group.resourceGroupName,
      location,
      kind: "AIServices",
    });
    const binding = withBinding
      ? yield* Azure.ContainerService.TrustedAccessRoleBinding("Binding", {
          resourceGroup: group.resourceGroupName,
          cluster: cluster.clusterName,
          sourceResourceId: account.accountId,
          roles: [role],
        })
      : undefined;
    return { group, cluster, account, binding };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03), an idle AI Services
// account (free) and the binding (~1 min). AI Services accounts offer the
// single `foundry-agent-operator` role, so there is no in-place role update.
test.provider(
  "create and delete a trusted access role binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(true));
      const { group, cluster, account } = created;
      const binding = created.binding!;
      expect(binding.roles).toEqual([role]);
      expect(binding.sourceResourceId.toLowerCase()).toEqual(
        account.accountId.toLowerCase(),
      );
      const observed = yield* getBinding(
        group.resourceGroupName,
        cluster.clusterName,
        binding.bindingName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.roles).toEqual([role]);

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
