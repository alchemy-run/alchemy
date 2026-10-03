import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { chain, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDataSet = (
  resourceGroupName: string,
  accountName: string,
  shareName: string,
  dataSetName: string,
) =>
  Effect.gen(function* () {
    return yield* datashare.GetDataSet({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      shareName,
      dataSetName,
    });
  });

// Data Share objects are free; a Standard_LRS storage account with empty
// containers costs nothing measurable. ~3-5 minutes (RBAC propagation).
test.provider(
  "create, replace, and delete a container data set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(chain({}));
      const { group, account, share, dataSet, source } = first;
      expect(dataSet.kind).toEqual("Container");
      expect(dataSet.dataSetId).not.toEqual("");
      const observed = yield* getDataSet(
        group.resourceGroupName,
        account.accountName,
        share.shareName,
        dataSet.dataSetName,
      );
      expect(observed.kind).toEqual("Container");
      expect(
        (observed.properties as { containerName?: string }).containerName,
      ).toEqual(source.containerName);

      // Replacement: point the data set at another container.
      const second = yield* stack.deploy(chain({ sourceContainer: "Source2" }));
      expect(second.dataSet.dataSetId).not.toEqual(dataSet.dataSetId);
      const reobserved = yield* getDataSet(
        group.resourceGroupName,
        account.accountName,
        share.shareName,
        second.dataSet.dataSetName,
      );
      expect(
        (reobserved.properties as { containerName?: string }).containerName,
      ).toEqual(second.source.containerName);
      expect(second.source.containerName).not.toEqual(source.containerName);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDataSet(
            group.resourceGroupName,
            account.accountName,
            share.shareName,
            second.dataSet.dataSetName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
