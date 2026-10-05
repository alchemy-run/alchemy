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

const program = (props: { logicalId: string }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const authorization = yield* Azure.VMware.ExpressRouteAuthorization(
      props.logicalId,
      {
        resourceGroup: group.resourceGroupName,
        privateCloud: cloud.privateCloudName,
      },
    );
    return { group, cloud, authorization };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, replace, and delete an ExpressRoute authorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, authorization } = yield* stack.deploy(
        program({ logicalId: "Gateway" }),
      );
      const get = (authorizationName: string) =>
        vmware.GetAuthorization({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          authorizationName,
        });
      const observed = yield* get(authorization.authorizationName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(authorization.expressRouteAuthorizationKey).toBeDefined();

      // Replacement: a new logical ID yields a new authorization.
      const replaced = yield* stack.deploy(program({ logicalId: "Gateway2" }));
      expect(replaced.authorization.authorizationName).not.toEqual(
        authorization.authorizationName,
      );
      expect(yield* waitGone(get(authorization.authorizationName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.authorization.authorizationName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
