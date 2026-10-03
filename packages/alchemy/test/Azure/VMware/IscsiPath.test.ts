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

const program = (props: { networkBlock: string }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const path = yield* Azure.VMware.IscsiPath("Iscsi", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      networkBlock: props.networkBlock,
    });
    return { group, cloud, path };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete the iSCSI path",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud } = yield* stack.deploy(
        program({ networkBlock: "10.180.0.0/24" }),
      );
      const get = () =>
        vmware.GetIscsiPath({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
        });
      expect((yield* get()).properties?.networkBlock).toEqual("10.180.0.0/24");

      // Replacement: the network block is immutable.
      yield* stack.deploy(program({ networkBlock: "10.181.0.0/24" }));
      expect((yield* get()).properties?.networkBlock).toEqual("10.181.0.0/24");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
