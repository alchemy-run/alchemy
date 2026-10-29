import * as GCP from "@alchemy.run/gcp";

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
