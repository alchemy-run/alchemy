import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vmware from "@distilled.cloud/azure/vmware";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  AVS_TIMEOUT,
  logLevel,
  privateCloud,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = () =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const policy = yield* Azure.VMware.PureStoragePolicy("Gold", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      storagePolicyDefinition: process.env.AZURE_TEST_AVS_PURE_POLICY ?? "",
      storagePoolId: process.env.AZURE_TEST_AVS_PURE_POOL_ID ?? "",
    });
    return { group, cloud, policy };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, plus a PureStorage.Block marketplace storage pool in AZURE_TEST_AVS_PURE_POOL_ID). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create and delete a Pure Storage policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, policy } = yield* stack.deploy(program());
      const get = () =>
        vmware.GetPureStoragePolicy({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          storagePolicyName: policy.storagePolicyName,
        });
      expect((yield* get()).properties?.storagePoolId?.toLowerCase()).toEqual(
        policy.storagePoolId.toLowerCase(),
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
