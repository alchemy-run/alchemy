import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** NetworkSecurity resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeAddressGroup = GCP.NetworkSecurity.AddressGroup("ProbeAddressGroup", {
  type: "IPV4",
  capacity: 100,
  items: ["10.0.0.1"],
  description: "address group a",
});
export const ProbeAuthorizationPolicy = GCP.NetworkSecurity.AuthorizationPolicy(
  "ProbeAuthorizationPolicy",
  {
    action: "ALLOW",
    description: "authz policy a",
  },
);
export const ProbeBackendAuthenticationConfig = GCP.NetworkSecurity.BackendAuthenticationConfig(
  "ProbeBackendAuthenticationConfig",
  {
    wellKnownRoots: "PUBLIC_ROOTS",
    description: "backend auth a",
  },
);
export const ProbeClientTlsPolicy = GCP.NetworkSecurity.ClientTlsPolicy("ProbeClientTlsPolicy", {
  location: "global",
  description: "client tls a",
  sni: "backend-a.example.com",
});
export const ProbeDnsThreatDetector = GCP.NetworkSecurity.DnsThreatDetector(
  "ProbeDnsThreatDetector",
  {
    location: "global",
    provider: "INFOBLOX",
  },
);
export const ProbeGatewaySecurityPolicy = GCP.NetworkSecurity.GatewaySecurityPolicy(
  "ProbeGatewaySecurityPolicy",
  {
    location: "us-central1",
    description: "gateway policy a",
  },
);
export const ProbeSacRealm = GCP.NetworkSecurity.SacRealm("ProbeSacRealm", {
  securityService: "PALO_ALTO_PRISMA_ACCESS",
});
export const ProbeSecurityProfile = GCP.NetworkSecurity.SecurityProfile("ProbeSecurityProfile", {
  location: "global",
  description: "threat profile a",
  type: "THREAT_PREVENTION",
  threatPreventionProfile: {
    severityOverrides: [{ severity: "HIGH", action: "ALERT" }],
  },
});
export const ProbeServerTlsPolicy = GCP.NetworkSecurity.ServerTlsPolicy("ProbeServerTlsPolicy", {
  location: "global",
  description: "server tls a",
  allowOpen: true,
});
export const ProbeUrlList = GCP.NetworkSecurity.UrlList("ProbeUrlList", {
  location: "us-central1",
  description: "url list a",
  values: ["malware.example.com"],
});

export const ProbeGatewayRule = Effect.gen(function* () {
  const policy = yield* ProbeGatewaySecurityPolicy;
  return yield* GCP.NetworkSecurity.GatewaySecurityPoliciesRule("ProbeGatewayRule", {
    gatewaySecurityPolicy: policy.name,
    location: "us-central1",
    basicProfile: "ALLOW",
    priority: 1000,
    enabled: true,
    sessionMatcher: "true",
  });
});

/** One VPC for the packet intercept and mirroring groups. */
const ProbeVpc = GCP.Compute.Network("ProbeSecurityVpc", { autoCreateSubnetworks: false });
export const ProbeInterceptGroup = Effect.gen(function* () {
  const vpc = yield* ProbeVpc;
  return yield* GCP.NetworkSecurity.InterceptDeploymentGroup("ProbeInterceptGroup", {
    location: "global",
    network: vpc.selfLink.as<string>(),
  });
});
export const ProbeInterceptEndpoints = Effect.gen(function* () {
  const group = yield* ProbeInterceptGroup;
  return yield* GCP.NetworkSecurity.InterceptEndpointGroup("ProbeInterceptEndpoints", {
    interceptDeploymentGroup: group.name,
  });
});
export const ProbeMirroringGroup = Effect.gen(function* () {
  const vpc = yield* ProbeVpc;
  return yield* GCP.NetworkSecurity.MirroringDeploymentGroup("ProbeMirroringGroup", {
    location: "global",
    network: vpc.selfLink.as<string>(),
  });
});
export const ProbeMirroringEndpoints = Effect.gen(function* () {
  const group = yield* ProbeMirroringGroup;
  return yield* GCP.NetworkSecurity.MirroringEndpointGroup("ProbeMirroringEndpoints", {
    mirroringDeploymentGroup: group.name,
  });
});
