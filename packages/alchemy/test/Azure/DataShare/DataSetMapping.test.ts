import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { chain, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMapping = (
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
  dataSetMappingName: string,
) =>
  Effect.gen(function* () {
    return yield* datashare.GetDataSetMapping({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
      dataSetMappingName,
    });
  });

const containerOf = (mapping: { properties?: unknown }) =>
  (mapping.properties as { containerName?: string }).containerName;

// Free Data Share objects + an empty Standard_LRS storage account; no
// snapshot runs, so no data movement is billed. ~5-7 minutes.
test.provider(
  "create, replace, and delete a container data set mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        chain({ consumer: true, mapping: true }),
      );
      const { group, dataSet } = first;
      const consumer = first.consumer!;
      const sub = first.subscription!;
      const mapping = first.mapping!;
      expect(mapping.kind).toEqual("Container");
      expect(mapping.dataSetId).toEqual(dataSet.dataSetId);
      const observed = yield* getMapping(
        group.resourceGroupName,
        consumer.accountName,
        sub.shareSubscriptionName,
        mapping.dataSetMappingName,
      );
      expect(observed.kind).toEqual("Container");
      const firstContainer = containerOf(observed);
      expect(firstContainer).toBeDefined();

      // Replacement: map into another container.
      const second = yield* stack.deploy(
        chain({ consumer: true, mapping: true, targetContainer: "Target2" }),
      );
      const mapping2 = second.mapping!;
      expect(mapping2.dataSetMappingId).not.toEqual(mapping.dataSetMappingId);
      const reobserved = yield* getMapping(
        group.resourceGroupName,
        consumer.accountName,
        sub.shareSubscriptionName,
        mapping2.dataSetMappingName,
      );
      expect(containerOf(reobserved)).not.toEqual(firstContainer);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getMapping(
            group.resourceGroupName,
            consumer.accountName,
            sub.shareSubscriptionName,
            mapping2.dataSetMappingName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
