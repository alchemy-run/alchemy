import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (resourceGroupName: string, hostGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetDedicatedHostGroup({
      subscriptionId,
      resourceGroupName,
      hostGroupName,
    }),
  );

// An empty dedicated host group is free and needs no host quota.
const program = (props: {
  faultDomains: number;
  automatic: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const hostGroup = yield* Azure.Compute.DedicatedHostGroup("Hosts", {
      resourceGroup: group.resourceGroupName,
      platformFaultDomainCount: props.faultDomains,
      supportAutomaticPlacement: props.automatic,
      tags: props.tags,
    });
    return { group, hostGroup };
  });

test.provider(
  "create, update, replace, and delete a dedicated host group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hostGroup } = yield* stack.deploy(
        program({ faultDomains: 1, automatic: false, tags: { env: "test" } }),
      );
      expect(hostGroup.platformFaultDomainCount).toEqual(1);
      expect(hostGroup.supportAutomaticPlacement).toEqual(false);
      expect(hostGroup.hostIds).toEqual([]);
      const observed = yield* getGroup(
        group.resourceGroupName,
        hostGroup.hostGroupName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hosts");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ faultDomains: 1, automatic: false, tags: { env: "prod" } }),
      );
      expect(updated.hostGroup.hostGroupId).toEqual(hostGroup.hostGroupId);
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        hostGroup.hostGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Fault domain count and automatic placement are immutable:
      // replacement.
      const replaced = yield* stack.deploy(
        program({ faultDomains: 2, automatic: true, tags: { env: "prod" } }),
      );
      expect(replaced.hostGroup.hostGroupName).not.toEqual(
        hostGroup.hostGroupName,
      );
      expect(replaced.hostGroup.platformFaultDomainCount).toEqual(2);
      expect(replaced.hostGroup.supportAutomaticPlacement).toEqual(true);
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, hostGroup.hostGroupName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, replaced.hostGroup.hostGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
