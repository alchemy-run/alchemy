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

const program = (props: { logLevel: "INFO" | "WARNING" }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const zone = yield* Azure.VMware.WorkloadNetworkDnsZone("Zone", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      domain: [],
      dnsServerIps: ["1.1.1.1"],
    });
    const resource = yield* Azure.VMware.WorkloadNetworkDnsService("Dns", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      displayName: "alchemy-dns",
      dnsServiceIp: "5.5.5.5",
      defaultDnsZone: zone.dnsZoneName,
      logLevel: props.logLevel,
    });
    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an NSX DNS service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ logLevel: "INFO" }),
      );
      const get = () =>
        vmware.GetWorkloadNetworkDnsService({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          dnsServiceId: resource.dnsServiceName,
        });
      const observed = yield* get();
      expect(observed.properties?.dnsServiceIp).toEqual("5.5.5.5");
      expect(observed.properties?.logLevel).toEqual("INFO");

      // In-place update.
      yield* stack.deploy(program({ logLevel: "WARNING" }));
      expect((yield* get()).properties?.logLevel).toEqual("WARNING");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
