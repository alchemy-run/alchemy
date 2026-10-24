import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAllocation = (resourceGroupName: string, ipAllocationName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetIpAllocation({ subscriptionId, resourceGroupName, ipAllocationName }),
  );

const program = (props: { owner: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const allocation = yield* Azure.Network.IpAllocation("Reserved", {
      resourceGroup: group.resourceGroupName,
      prefix: "10.20.0.0/24",
      allocationTags: { owner: props.owner },
      tags: { env: props.env },
    });
    return { group, allocation };
  });

// IP allocations are free, but Azure only creates them in subscriptions
// allow-listed for Hypernet. Run with AZURE_TEST_PAID=1 on such a
// subscription.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an IP allocation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, allocation } = yield* stack.deploy(
        program({ owner: "platform", env: "test" }),
      );
      expect(allocation.prefix).toEqual("10.20.0.0/24");
      const observed = yield* getAllocation(group.resourceGroupName, allocation.ipAllocationName);
      expect(observed.properties?.allocationTags?.owner).toEqual("platform");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ owner: "network", env: "prod" }));
      expect(updated.allocation.ipAllocationId).toEqual(allocation.ipAllocationId);
      const reobserved = yield* getAllocation(group.resourceGroupName, allocation.ipAllocationName);
      expect(reobserved.properties?.allocationTags?.owner).toEqual("network");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getAllocation(group.resourceGroupName, allocation.ipAllocationName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Free: the PUT is rejected before anything is created.
test.provider.skipIf(runPaidOnly)(
  "an IP allocation needs a Hypernet-onboarded subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(program({ owner: "platform", env: "test" }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("HypernetNotOnboarded");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
