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
    const peer = yield* Azure.VMware.PrivateCloud("Peer", {
      resourceGroup: group.resourceGroupName,
      sku: "av36p",
      networkBlock: "10.176.0.0/22",
      clusterSize: 3,
    });
    const link = yield* Azure.VMware.CloudLink("Link", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      linkedCloud: peer.privateCloudId,
    });
    return { group, cloud, peer, link };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, doubled for the second private cloud). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create and delete a cloud link between two private clouds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, peer, link } = yield* stack.deploy(program());
      const get = () =>
        vmware.GetCloudLink({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          cloudLinkName: link.cloudLinkName,
        });
      const observed = yield* get();
      expect(observed.properties?.linkedCloud?.toLowerCase()).toEqual(
        peer.privateCloudId.toLowerCase(),
      );
      expect(link.status).toEqual("Active");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
