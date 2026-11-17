import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:networkservices", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-agent-gateway": GCP.NetworkServices.AgentGateway.lookup({ agentGatewayId: name })
          .name,
        "missing-authz-extension": GCP.NetworkServices.AuthzExtension.lookup({
          authzExtensionId: name,
        }).name,
        "missing-endpoint-policy": GCP.NetworkServices.EndpointPolicy.lookup({
          endpointPolicyId: name,
        }).name,
        "missing-gateway": GCP.NetworkServices.Gateway.lookup({ gatewayId: name }).name,
        "missing-grpc-route": GCP.NetworkServices.GrpcRoute.lookup({ grpcRouteId: name }).name,
        "missing-http-route": GCP.NetworkServices.HttpRoute.lookup({ httpRouteId: name }).name,
        "missing-lb-edge-extension": GCP.NetworkServices.LbEdgeExtension.lookup({
          lbEdgeExtensionId: name,
        }).name,
        "missing-lb-route-extension": GCP.NetworkServices.LbRouteExtension.lookup({
          lbRouteExtensionId: name,
        }).name,
        "missing-lb-traffic-extension": GCP.NetworkServices.LbTrafficExtension.lookup({
          lbTrafficExtensionId: name,
        }).name,
        "missing-mesh": GCP.NetworkServices.Mesh.lookup({ meshId: name }).name,
        "missing-multicast-consumer-association":
          GCP.NetworkServices.MulticastConsumerAssociation.lookup({
            multicastConsumerAssociationId: name,
          }).name,
        "missing-multicast-group-consumer-activation":
          GCP.NetworkServices.MulticastGroupConsumerActivation.lookup({
            multicastGroupConsumerActivationId: name,
          }).name,
        "missing-service-binding": GCP.NetworkServices.ServiceBinding.lookup({
          serviceBindingId: name,
        }).name,
        "missing-service-lb-policy": GCP.NetworkServices.ServiceLbPolicy.lookup({
          serviceLbPolicyId: name,
        }).name,
        "missing-tcp-route": GCP.NetworkServices.TcpRoute.lookup({ tcpRouteId: name }).name,
        "missing-tls-route": GCP.NetworkServices.TlsRoute.lookup({ tlsRouteId: name }).name,
        "missing-wasm-plugin": GCP.NetworkServices.WasmPlugin.lookup({ wasmPluginId: name }).name,
        "missing-wasm-plugins-version": GCP.NetworkServices.WasmPluginsVersion.lookup({
          wasmPluginVersionId: name,
          wasmPlugin: name,
        }).name,
      });
    }),
  { tags, timeout: 330000 },
);
