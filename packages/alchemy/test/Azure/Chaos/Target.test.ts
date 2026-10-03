import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as chaos from "@distilled.cloud/azure/chaos";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTarget = (resourceGroupName: string, nsgName: string) =>
  Effect.gen(function* () {
    return yield* chaos.GetTarget({
      subscriptionId: yield* subscription,
      resourceGroupName,
      parentProviderNamespace: "Microsoft.Network",
      parentResourceType: "networkSecurityGroups",
      parentResourceName: nsgName,
      targetName: "Microsoft-NetworkSecurityGroup",
    });
  });

const program = (parent: "Primary" | "Secondary") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both NSGs stay deployed across the replacement step.
    const primary = yield* Azure.Network.NetworkSecurityGroup("Primary", {
      resourceGroup: group.resourceGroupName,
    });
    const secondary = yield* Azure.Network.NetworkSecurityGroup("Secondary", {
      resourceGroup: group.resourceGroupName,
    });
    const nsg = parent === "Primary" ? primary : secondary;
    const target = yield* Azure.Chaos.Target("Target", {
      parentResourceId: nsg.networkSecurityGroupId,
      targetType: "Microsoft-NetworkSecurityGroup",
    });
    return { group, nsg, target };
  });

// NSGs and Chaos targets are free; provisions in ~1 minute.
test.provider(
  "create, replace, and delete a chaos target",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nsg, target } = yield* stack.deploy(program("Primary"));
      expect(target.targetName).toEqual("Microsoft-NetworkSecurityGroup");
      expect(target.targetId.toLowerCase()).toEqual(
        `${nsg.networkSecurityGroupId}/providers/Microsoft.Chaos/targets/Microsoft-NetworkSecurityGroup`.toLowerCase(),
      );
      const observed = yield* getTarget(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
      );
      expect(observed.id?.toLowerCase()).toEqual(target.targetId.toLowerCase());

      // Redeploying the same program is a no-op that keeps the target.
      const same = yield* stack.deploy(program("Primary"));
      expect(same.target.targetId).toEqual(target.targetId);

      // Replacement: moving the target to another parent.
      const replaced = yield* stack.deploy(program("Secondary"));
      expect(replaced.target.parentResourceId).toEqual(
        replaced.nsg.networkSecurityGroupId,
      );
      expect(replaced.target.targetId).not.toEqual(target.targetId);
      const replacedObserved = yield* getTarget(
        group.resourceGroupName,
        replaced.nsg.networkSecurityGroupName,
      );
      expect(replacedObserved.id?.toLowerCase()).toEqual(
        replaced.target.targetId.toLowerCase(),
      );
      expect(
        yield* waitGone(
          getTarget(group.resourceGroupName, nsg.networkSecurityGroupName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getTarget(
            group.resourceGroupName,
            replaced.nsg.networkSecurityGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
