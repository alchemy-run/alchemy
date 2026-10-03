import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as powerbidedicated from "@distilled.cloud/azure/powerbidedicated";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCapacity = (
  resourceGroupName: string,
  dedicatedCapacityName: string,
) =>
  Effect.gen(function* () {
    return yield* powerbidedicated.GetCapacityDetails({
      subscriptionId: yield* subscription,
      resourceGroupName,
      dedicatedCapacityName,
    });
  });

const program = (props: {
  location: string;
  tags: Record<string, string>;
  suspended?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Admin",
      { resourceGroup: group.resourceGroupName, location: "eastus" },
    );
    const capacity = yield* Azure.PowerBI.Capacity("Capacity", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: "A1",
      administrators: [identity.principalId],
      suspended: props.suspended,
      tags: props.tags,
    });
    return { group, identity, capacity };
  });

// A1 capacity (~$1.01/hour, billed per second while running): ~3-6 minutes
// running per run, about $0.10. Needs a tenant signed up for Microsoft
// Fabric / Power BI; the free-trial tenant is not (see the probe below).
test.provider.skipIf(!runPaidOnly)(
  "create, update, suspend, replace, and delete a Power BI capacity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity, capacity } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      const get = (name: string) => getCapacity(group.resourceGroupName, name);
      expect(capacity.sku).toEqual("A1");
      expect(capacity.suspended).toEqual(false);
      const observed = yield* get(capacity.capacityName);
      expect(observed.properties?.administration?.members).toEqual([
        identity.principalId,
      ]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties?.state).toEqual("Succeeded");

      // In-place: retag and pause the capacity.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "updated" },
          suspended: true,
        }),
      );
      expect(updated.capacity.capacityId).toEqual(capacity.capacityId);
      expect(updated.capacity.suspended).toEqual(true);
      const reobserved = yield* get(capacity.capacityName);
      expect(reobserved.tags?.env).toEqual("updated");
      expect(reobserved.properties?.state).toEqual("Paused");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "updated" },
          suspended: true,
        }),
      );
      expect(replaced.capacity.capacityId).not.toEqual(capacity.capacityId);
      expect(replaced.capacity.location.toLowerCase()).toEqual("westus2");
      expect(yield* waitGone(get(capacity.capacityName))).toEqual("gone");
      const replacedObserved = yield* get(replaced.capacity.capacityName);
      expect(replacedObserved.properties?.state).toEqual("Paused");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.capacity.capacityName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): the testing tenant has never signed up for
// Microsoft Fabric, so ARM rejects the capacity PUT with
// the typed tenant error and nothing is created.
test.provider(
  "an unsigned tenant rejects capacities with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
            "Admin",
            { resourceGroup: group.resourceGroupName, location: "eastus" },
          );
          return { group, identity };
        }),
      );
      const error = yield* powerbidedicated
        .CreateCapacity({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          dedicatedCapacityName: "alchemypowerbiprobe",
          location: "eastus",
          sku: { name: "A1", tier: "PBIE_Azure" },
          properties: {
            administration: { members: [identity.principalId] },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("PowerBITenantNotSignedUp");
      expect(
        yield* waitGone(
          getCapacity(group.resourceGroupName, "alchemypowerbiprobe"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
