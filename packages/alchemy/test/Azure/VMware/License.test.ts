import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vmware from "@distilled.cloud/azure/vmware";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

const program = (props: { endDate: string }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const license = yield* Azure.VMware.License("Firewall", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      licenseKey: Redacted.make(
        process.env.AZURE_TEST_AVS_FIREWALL_LICENSE ?? "",
      ),
      endDate: props.endDate,
    });
    return { group, cloud, license };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, plus a Broadcom vDefend license key in AZURE_TEST_AVS_FIREWALL_LICENSE). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, update, and delete a VMware firewall license",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, license } = yield* stack.deploy(
        program({ endDate: "2027-12-31T00:00:00Z" }),
      );
      const get = () =>
        vmware.GetLicense({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          licenseName: license.licenseName,
        });
      expect((yield* get()).properties?.kind).toEqual("VmwareFirewall");

      // In-place: extend the license.
      yield* stack.deploy(program({ endDate: "2028-12-31T00:00:00Z" }));
      expect(
        new Date((yield* get()).properties?.endDate ?? "").getUTCFullYear(),
      ).toEqual(2028);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
