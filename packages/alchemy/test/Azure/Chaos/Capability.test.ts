import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as chaos from "@distilled.cloud/azure/chaos";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCapability = (
  resourceGroupName: string,
  nsgName: string,
  capabilityName: string,
) =>
  Effect.gen(function* () {
    return yield* chaos.GetCapability({
      subscriptionId: yield* subscription,
      resourceGroupName,
      parentProviderNamespace: "Microsoft.Network",
      parentResourceType: "networkSecurityGroups",
      parentResourceName: nsgName,
      targetName: "Microsoft-NetworkSecurityGroup",
      capabilityName,
    });
  });

const program = (capabilityType: "SecurityRule-1.0" | "SecurityRule-1.1") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
      resourceGroup: group.resourceGroupName,
    });
    const target = yield* Azure.Chaos.Target("Target", {
      parentResourceId: nsg.networkSecurityGroupId,
      targetType: "Microsoft-NetworkSecurityGroup",
    });
    const capability = yield* Azure.Chaos.Capability("Capability", {
      targetId: target.targetId,
      capabilityType,
    });
    return { group, nsg, target, capability };
  });

// NSGs, targets, and capabilities are free; provisions in ~1 minute.
test.provider(
  "create, replace, and delete a chaos capability",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nsg, capability } = yield* stack.deploy(
        program("SecurityRule-1.0"),
      );
      const get = (name: string) =>
        getCapability(
          group.resourceGroupName,
          nsg.networkSecurityGroupName,
          name,
        );
      expect(capability.capabilityName).toEqual("SecurityRule-1.0");
      expect(capability.urn).toEqual(
        "urn:csci:microsoft:networkSecurityGroup:securityRule/1.0",
      );
      const observed = yield* get("SecurityRule-1.0");
      expect(observed.properties?.urn).toEqual(capability.urn);

      // Replacement: the capability type is the name.
      const replaced = yield* stack.deploy(program("SecurityRule-1.1"));
      expect(replaced.capability.capabilityName).toEqual("SecurityRule-1.1");
      expect(replaced.capability.urn).toEqual(
        "urn:csci:microsoft:networkSecurityGroup:securityRule/1.1",
      );
      expect((yield* get("SecurityRule-1.1")).properties?.urn).toEqual(
        replaced.capability.urn,
      );
      expect(yield* waitGone(get("SecurityRule-1.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("SecurityRule-1.1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
