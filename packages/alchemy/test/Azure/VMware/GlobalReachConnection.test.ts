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
    const authorization = yield* Azure.VMware.ExpressRouteAuthorization(
      "PeerAuth",
      {
        resourceGroup: group.resourceGroupName,
        privateCloud: peer.privateCloudName,
      },
    );
    const connection = yield* Azure.VMware.GlobalReachConnection("Reach", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      peerExpressRouteCircuit: peer.circuit.expressRouteId,
      authorizationKey: authorization.expressRouteAuthorizationKey,
    });
    return { group, cloud, peer, connection };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, doubled for the second private cloud). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create and delete a Global Reach connection between two private clouds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, peer, connection } = yield* stack.deploy(program());
      const get = () =>
        vmware.GetGlobalReachConnection({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          globalReachConnectionName: connection.globalReachConnectionName,
        });
      const observed = yield* get();
      expect(
        observed.properties?.peerExpressRouteCircuit?.toLowerCase(),
      ).toEqual(peer.circuit.expressRouteId?.toLowerCase());
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
