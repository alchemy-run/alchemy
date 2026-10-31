import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

const region = "us-central1";

/**
 * A regional internal Application Load Balancer on its own network (a subnet
 * for the forwarding rule's address, a proxy-only subnet for its Envoy
 * proxies) plus an HTTP/2 backend service an extension can call out to.
 * Holds one VPC quota slot: run it under `withNetworkSlot`.
 */
export const InternalAlb = Effect.gen(function* () {
  const network = yield* GCP.Compute.Network("LbVpc", {
    autoCreateSubnetworks: false,
  });
  const subnet = yield* GCP.Compute.Subnetwork("LbSubnet", {
    region,
    network: network.networkName,
    ipCidrRange: "10.10.0.0/24",
  });
  const proxySubnet = yield* GCP.Compute.Subnetwork("LbProxySubnet", {
    region,
    network: network.networkName,
    ipCidrRange: "10.129.0.0/23",
    purpose: "REGIONAL_MANAGED_PROXY",
  });
  const healthCheck = yield* GCP.Compute.HealthCheck("Hc", {
    type: "HTTP",
    httpHealthCheck: { port: 80, requestPath: "/" },
  });
  const backend = yield* GCP.Compute.RegionBackendService("Backend", {
    region,
    loadBalancingScheme: "INTERNAL_MANAGED",
    protocol: "HTTP",
    healthChecks: [healthCheck.selfLink.as<string>()],
  });
  const urlMap = yield* GCP.Compute.RegionUrlMap("Map", {
    region,
    defaultService: backend.selfLink.as<string>(),
  });
  const proxy = yield* GCP.Compute.RegionTargetHttpProxy("Proxy", {
    region,
    urlMap: urlMap.selfLink.as<string>(),
  });
  const address = yield* GCP.Compute.Address("Ip", {
    region,
    addressType: "INTERNAL",
    subnetwork: subnet.selfLink.as<string>(),
  });
  const rule = yield* GCP.Compute.ForwardingRule("Rule", {
    region,
    // The rule needs the proxy-only subnet to exist first.
    description: Output.interpolate`internal ALB on ${proxySubnet.subnetworkName}`,
    loadBalancingScheme: "INTERNAL_MANAGED",
    ipProtocol: "TCP",
    portRange: "80",
    target: proxy.selfLink.as<string>(),
    ipAddress: address.selfLink.as<string>(),
    network: network.selfLink.as<string>(),
    subnetwork: subnet.selfLink.as<string>(),
  });
  const callout = yield* GCP.Compute.RegionBackendService("Callout", {
    region,
    loadBalancingScheme: "INTERNAL_MANAGED",
    protocol: "HTTP2",
    healthChecks: [healthCheck.selfLink.as<string>()],
  });
  return {
    rule: rule.selfLink.as<string>(),
    callout: callout.selfLink.as<string>(),
  };
});
