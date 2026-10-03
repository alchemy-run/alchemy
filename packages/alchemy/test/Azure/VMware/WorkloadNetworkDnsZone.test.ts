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

const program = (props: { dnsServerIps: string[] }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const resource = yield* Azure.VMware.WorkloadNetworkDnsZone("Zone", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      displayName: "alchemy-zone",
      domain: ["corp.example.com"],
      dnsServerIps: props.dnsServerIps,
    });

    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an NSX DNS zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ dnsServerIps: ["10.0.0.4"] }),
      );
      const get = () =>
        vmware.GetWorkloadNetworkDnsZone({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          dnsZoneId: resource.dnsZoneName,
        });
      const observed = yield* get();
      expect(observed.properties?.dnsServerIps).toEqual(["10.0.0.4"]);

      // In-place update.
      const updated = yield* stack.deploy(
        program({ dnsServerIps: ["10.0.0.4", "10.0.0.5"] }),
      );
      expect(updated.resource.dnsZoneName).toEqual(resource.dnsZoneName);
      const reobserved = yield* get();
      expect([...(reobserved.properties?.dnsServerIps ?? [])].sort()).toEqual([
        "10.0.0.4",
        "10.0.0.5",
      ]);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
