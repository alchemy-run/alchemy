import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as powerbidedicated from "@distilled.cloud/azure/powerbidedicated";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Object ID of a Power BI Premium Gen2 (P-SKU) capacity, purchased through
 * Microsoft 365 licensing — the free trial cannot create one.
 */
const premiumCapacityObjectId =
  process.env.AZURE_TEST_POWERBI_PREMIUM_CAPACITY_OBJECT_ID;

const getVCore = (resourceGroupName: string, vcoreName: string) =>
  Effect.gen(function* () {
    return yield* powerbidedicated.GetAutoScaleVCore({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vcoreName,
    });
  });

const program = (props: {
  location: string;
  capacityLimit: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vcore = yield* Azure.PowerBI.AutoScaleVCore("VCore", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      capacityObjectId: premiumCapacityObjectId!,
      capacityLimit: props.capacityLimit,
      tags: props.tags,
    });
    return { group, vcore };
  });

// Needs a Power BI Premium Gen2 capacity (Microsoft 365 purchase, thousands
// of USD/month) in the test tenant; autoscale v-cores themselves bill only
// when used (~$85 per v-core per 24h).
test.provider.skipIf(!runPaidOnly || !premiumCapacityObjectId)(
  "create, update, replace, and delete an auto scale v-core",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vcore } = yield* stack.deploy(
        program({ location: "eastus", capacityLimit: 2, tags: { env: "a" } }),
      );
      const get = (name: string) => getVCore(group.resourceGroupName, name);
      const observed = yield* get(vcore.vcoreName);
      expect(observed.properties?.capacityObjectId).toEqual(
        premiumCapacityObjectId,
      );
      expect(observed.properties?.capacityLimit).toEqual(2);

      const updated = yield* stack.deploy(
        program({ location: "eastus", capacityLimit: 4, tags: { env: "b" } }),
      );
      expect(updated.vcore.vcoreId).toEqual(vcore.vcoreId);
      const reobserved = yield* get(vcore.vcoreName);
      expect(reobserved.properties?.capacityLimit).toEqual(4);
      expect(reobserved.tags?.env).toEqual("b");

      const replaced = yield* stack.deploy(
        program({ location: "westus2", capacityLimit: 4, tags: { env: "b" } }),
      );
      expect(replaced.vcore.vcoreId).not.toEqual(vcore.vcoreId);
      expect(yield* waitGone(get(vcore.vcoreName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.vcore.vcoreName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): without a Power BI Premium capacity in the tenant,
// an auto scale v-core that references an unknown capacity object ID is
// rejected and nothing is created.
test.provider(
  "an unknown Premium capacity object ID is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Azure.Resources.ResourceGroup("Group", { location: "eastus" }).pipe(
          Effect.map((group) => ({ group })),
        ),
      );
      const error = yield* powerbidedicated
        .CreateAutoScaleVCore({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          vcoreName: "alchemyvcoreprobe",
          location: "eastus",
          sku: { name: "AutoScale", tier: "AutoScale", capacity: 0 },
          properties: {
            capacityObjectId: "00000000-0000-0000-0000-000000000001",
            capacityLimit: 1,
          },
        })
        .pipe(Effect.flip);
      // The resource provider answers with a bare 401 (no ARM error body),
      // so only the HTTP status error can be typed.
      expect(error._tag).toEqual("Unauthorized");
      expect(
        yield* waitGone(getVCore(group.resourceGroupName, "alchemyvcoreprobe")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
