import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getBlock = (resourceGroupName: string, interconnectBlockName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetInterconnectBlock({
      subscriptionId,
      resourceGroupName,
      interconnectBlockName,
    }),
  );

/** GPU size and interconnect group of an allow-listed subscription. */
const SKU =
  process.env.AZURE_TEST_INTERCONNECT_SKU ?? "Standard_ND96isr_H100_v5";
const INTERCONNECT_GROUP_ID =
  process.env.AZURE_TEST_INTERCONNECT_GROUP_ID ?? "";

test.provider(
  "probe: interconnect blocks are rejected without allow-listing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = yield* subscriptionId;
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* compute
        .InterconnectBlocksCreateOrUpdate({
          subscriptionId: id,
          resourceGroupName: group.resourceGroupName,
          interconnectBlockName: "probe",
          location: "eastus",
          sku: { name: SKU, capacity: 1 },
          properties: {
            interconnectGroup: {
              id: `/subscriptions/${id}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Compute/interconnectGroups/probe`,
            },
          },
        })
        .pipe(Effect.flip);
      // The resource type is not exposed to subscriptions without the
      // preview feature.
      expect(error._tag).toEqual("InvalidResourceType");
      expect(error.message).toContain("Microsoft.Compute");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

// GPU interconnect capacity (H100 class, tens of dollars per hour) on an
// allow-listed subscription with an interconnect group: paid only.
test.provider.skipIf(!runPaidOnly || INTERCONNECT_GROUP_ID === "")(
  "create, update, and delete an interconnect block",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (props: { tags: Record<string, string> }) =>
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const block = yield* Azure.Compute.InterconnectBlock("Block", {
            resourceGroup: group.resourceGroupName,
            sku: SKU,
            capacity: 1,
            interconnectGroupId: INTERCONNECT_GROUP_ID,
            tags: props.tags,
          });
          return { group, block };
        });

      const { group, block } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(block.sku).toEqual(SKU);
      const observed = yield* getBlock(
        group.resourceGroupName,
        block.interconnectBlockName,
      );
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.block.interconnectBlockResourceId).toEqual(
        block.interconnectBlockResourceId,
      );
      const reobserved = yield* getBlock(
        group.resourceGroupName,
        block.interconnectBlockName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getBlock(group.resourceGroupName, block.interconnectBlockName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
