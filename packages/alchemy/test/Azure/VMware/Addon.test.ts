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

const program = (props: { vrsCount: number }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const addon = yield* Azure.VMware.Addon("Replication", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      addonType: "VR",
      vrsCount: props.vrsCount,
    });
    return { group, cloud, addon };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, update, and delete an add-on",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, addon } = yield* stack.deploy(
        program({ vrsCount: 1 }),
      );
      expect(addon.addonName).toEqual("vr");
      const get = () =>
        vmware.GetAddon({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          addonName: addon.addonName,
        });
      const observed = yield* get();
      expect(observed.properties?.addonType).toEqual("VR");
      expect(observed.properties?.vrsCount).toEqual(1);

      // In-place: add a replication server.
      yield* stack.deploy(program({ vrsCount: 2 }));
      expect((yield* get()).properties?.vrsCount).toEqual(2);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
