import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:networkconnectivity", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-automated-dns-record": GCP.NetworkConnectivity.AutomatedDnsRecord.lookup({
          automatedDnsRecordId: name,
        }).name,
        "missing-hub": GCP.NetworkConnectivity.Hub.lookup({ hubId: name }).name,
        "missing-internal-range": GCP.NetworkConnectivity.InternalRange.lookup({
          internalRangeId: name,
        }).name,
        "missing-multicloud-data-transfer-config":
          GCP.NetworkConnectivity.MulticloudDataTransferConfig.lookup({
            multicloudDataTransferConfigId: name,
          }).name,
        "missing-policy-based-route": GCP.NetworkConnectivity.PolicyBasedRoute.lookup({
          policyBasedRouteId: name,
        }).name,
        "missing-regional-endpoint": GCP.NetworkConnectivity.RegionalEndpoint.lookup({
          regionalEndpointId: name,
        }).name,
        "missing-service-connection-map": GCP.NetworkConnectivity.ServiceConnectionMap.lookup({
          serviceConnectionMapId: name,
        }).name,
        "missing-service-connection-policy": GCP.NetworkConnectivity.ServiceConnectionPolicy.lookup(
          { serviceConnectionPolicyId: name },
        ).name,
        "missing-spoke": GCP.NetworkConnectivity.Spoke.lookup({ spokeId: name }).name,
        "missing-spokes-gateway-advertised-route":
          GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute.lookup({
            gatewayAdvertisedRouteId: name,
            parent: name,
          }).name,
        "missing-transport": GCP.NetworkConnectivity.Transport.lookup({ transportId: name }).name,
      });
    }),
  { tags, timeout: 225000 },
);
