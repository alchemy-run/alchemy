import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { InternalAlb } from "../../internalAlb.ts";

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
export const ProbeProfileGroup = Effect.gen(function* () {
  const profile = yield* ProbeSecurityProfile;
  return yield* GCP.NetworkSecurity.SecurityProfileGroup("ProbeProfileGroup", {
    location: "global",
    threatPreventionProfile: profile.name,
  });
});

const ProbeCollectorSubnet = Effect.gen(function* () {
  const vpc = yield* ProbeVpc;
  return yield* GCP.Compute.Subnetwork("ProbeCollectorSubnet", {
    region: "us-central1",
    network: vpc.selfLink.as<string>(),
    ipCidrRange: "10.91.0.0/24",
  });
});
/** An internal UDP load balancer in the probe VPC: the collectors' front end. */
const collectorRule = (
  id: string,
  rule: { ports?: string[]; allPorts?: boolean; isMirroringCollector?: boolean },
) =>
  Effect.gen(function* () {
    const vpc = yield* ProbeVpc;
    const subnet = yield* ProbeCollectorSubnet;
    const health = yield* GCP.Compute.RegionHealthCheck(`${id}Hc`, {
      region: "us-central1",
      type: "TCP",
      tcpHealthCheck: { port: 80 },
    });
    const backend = yield* GCP.Compute.RegionBackendService(`${id}Backend`, {
      region: "us-central1",
      protocol: "UDP",
      loadBalancingScheme: "INTERNAL",
      network: vpc.selfLink,
      healthChecks: [health.selfLink.as<string>()],
    });
    return yield* GCP.Compute.ForwardingRule(`${id}Rule`, {
      region: "us-central1",
      loadBalancingScheme: "INTERNAL",
      ipProtocol: "UDP",
      network: vpc.selfLink,
      subnetwork: subnet.selfLink,
      backendService: backend.selfLink,
      ...rule,
    });
  });
export const ProbeInterceptDeployment = Effect.gen(function* () {
  const group = yield* ProbeInterceptGroup;
  const rule = yield* collectorRule("ProbeIntercept", { ports: ["6081"] });
  return yield* GCP.NetworkSecurity.InterceptDeployment("ProbeInterceptDeployment", {
    location: "us-central1-a",
    interceptDeploymentGroup: group.name,
    forwardingRule: rule.selfLink.as<string>(),
  });
});
export const ProbeMirroringDeployment = Effect.gen(function* () {
  const group = yield* ProbeMirroringGroup;
  const rule = yield* collectorRule("ProbeMirroring", {
    allPorts: true,
    isMirroringCollector: true,
  });
  return yield* GCP.NetworkSecurity.MirroringDeployment("ProbeMirroringDeployment", {
    location: "us-central1-a",
    mirroringDeploymentGroup: group.name,
    forwardingRule: rule.selfLink.as<string>(),
  });
});
const ProbeConsumerVpc = GCP.Compute.Network("ProbeConsumerVpc", { autoCreateSubnetworks: false });
export const ProbeInterceptAssociation = Effect.gen(function* () {
  const consumer = yield* ProbeConsumerVpc;
  const endpoints = yield* ProbeInterceptEndpoints;
  return yield* GCP.NetworkSecurity.InterceptEndpointGroupAssociation("ProbeInterceptAssociation", {
    interceptEndpointGroup: endpoints.name,
    network: consumer.selfLink.as<string>(),
  });
});
export const ProbeMirroringAssociation = Effect.gen(function* () {
  const consumer = yield* ProbeConsumerVpc;
  const endpoints = yield* ProbeMirroringEndpoints;
  return yield* GCP.NetworkSecurity.MirroringEndpointGroupAssociation("ProbeMirroringAssociation", {
    mirroringEndpointGroup: endpoints.name,
    network: consumer.selfLink.as<string>(),
  });
});
export const ProbeTlsInspectionPolicy = Effect.gen(function* () {
  const pool = yield* GCP.PrivateCA.CaPool("ProbeInspectPool", {
    location: "us-central1",
    tier: "DEVOPS",
  });
  const ca = yield* GCP.PrivateCA.CertificateAuthority("ProbeInspectRoot", {
    caPool: pool.name,
    location: "us-central1",
    type: "SELF_SIGNED",
    desiredState: "ENABLED",
  });
  return yield* GCP.NetworkSecurity.TlsInspectionPolicy("ProbeTlsInspectionPolicy", {
    location: "us-central1",
    caPool: pool.name,
    description: Output.interpolate`probe ${ca.certificateAuthorityId}`,
    excludePublicCaSet: true,
  });
});

/** A Cloud NGFW endpoint, and its association with a network of its own. */
export const ProbeFirewallEndpoint = GCP.NetworkSecurity.FirewallEndpoint("ProbeFirewallEndpoint", {
  location: "us-central1-a",
  description: "alchemy probe",
});
export const ProbeFirewallAssociation = Effect.gen(function* () {
  const vpc = yield* GCP.Compute.Network("ProbeNgfwVpc", { autoCreateSubnetworks: false });
  const endpoint = yield* ProbeFirewallEndpoint;
  return yield* GCP.NetworkSecurity.FirewallEndpointAssociation("ProbeFirewallAssociation", {
    location: "us-central1-a",
    firewallEndpoint: endpoint.name,
    network: vpc.selfLink.as<string>(),
  });
});

/** An authorization policy on an internal Application Load Balancer. */
export const ProbeAuthzPolicy = Effect.gen(function* () {
  const alb = yield* InternalAlb;
  return yield* GCP.NetworkSecurity.AuthzPolicy("ProbeAuthzPolicy", {
    location: "us-central1",
    action: "ALLOW",
    target: { loadBalancingScheme: "INTERNAL_MANAGED", resources: [alb.rule] },
    httpRules: [{ to: { operations: [{ methods: ["GET"], paths: [{ prefix: "/admin" }] }] } }],
  });
});
