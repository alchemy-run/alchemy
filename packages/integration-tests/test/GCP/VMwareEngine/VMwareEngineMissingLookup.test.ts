import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:vmwareengine", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-datastore": GCP.VMwareEngine.Datastore.lookup({ datastoreId: name }).name,
        "missing-network-peering": GCP.VMwareEngine.NetworkPeering.lookup({
          networkPeeringId: name,
        }).name,
        "missing-network-policies-external-access-rule":
          GCP.VMwareEngine.NetworkPoliciesExternalAccessRule.lookup({
            externalAccessRuleId: name,
            networkPolicy: name,
          }).name,
        "missing-network-policy": GCP.VMwareEngine.NetworkPolicy.lookup({ networkPolicyId: name })
          .name,
        "missing-private-cloud": GCP.VMwareEngine.PrivateCloud.lookup({ privateCloudId: name })
          .name,
        "missing-private-clouds-cluster": GCP.VMwareEngine.PrivateCloudsCluster.lookup({
          clusterId: name,
          privateCloud: name,
        }).name,
        "missing-private-clouds-external-address":
          GCP.VMwareEngine.PrivateCloudsExternalAddress.lookup({
            externalAddressId: name,
            privateCloud: name,
          }).name,
        "missing-private-clouds-logging-server": GCP.VMwareEngine.PrivateCloudsLoggingServer.lookup(
          { loggingServerId: name, privateCloud: name },
        ).name,
        "missing-private-connection": GCP.VMwareEngine.PrivateConnection.lookup({
          privateConnectionId: name,
        }).name,
        "missing-vmware-engine-network": GCP.VMwareEngine.VmwareEngineNetwork.lookup({
          vmwareEngineNetworkId: name,
        }).name,
      });
    }),
  { tags, timeout: 210000 },
);
