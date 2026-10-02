import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "southcentralus";

const getSafeguard = (resourceUri: string) =>
  cs.GetDeploymentSafeguard({ resourceUri });

const program = (level: "Warn" | "Enforce") =>
  Effect.gen(function* () {
    // Safeguards are enforced through the Azure Policy add-on.
    const { group, cluster } = yield* testCluster(location, {
      addonProfiles: { azurepolicy: { enabled: true } },
    });
    const safeguard = yield* Azure.ContainerService.DeploymentSafeguard(
      "Safeguard",
      {
        clusterId: cluster.clusterId,
        level,
        excludedNamespaces: ["legacy"],
      },
    );
    return { group, cluster, safeguard };
  });

// Test cluster with the Azure Policy add-on (~$0.05) plus safeguards, whose
// policy propagation takes 10-20 minutes: ~25-30 min in total, over the
// time budget. Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete deployment safeguards",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("Warn"));
      const { cluster, safeguard } = created;
      expect(safeguard.level).toEqual("Warn");
      expect(safeguard.excludedNamespaces).toEqual(["legacy"]);
      const observed = yield* getSafeguard(cluster.clusterId);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program("Enforce"));
      expect(updated.safeguard.level).toEqual("Enforce");
      const reobserved = yield* getSafeguard(cluster.clusterId);
      expect(reobserved.properties?.level).toEqual("Enforce");

      yield* stack.destroy();
      expect(yield* untilGone(getSafeguard(cluster.clusterId))).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
