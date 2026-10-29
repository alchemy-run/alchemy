import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** NetworkServices resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeGateway = GCP.NetworkServices.Gateway("ProbeGateway", {
  location: "global",
  type: "OPEN_MESH",
  ports: [443],
  description: "gateway a",
});
export const ProbeGrpcRoute = GCP.NetworkServices.GrpcRoute("ProbeGrpcRoute", {
  location: "global",
  hostnames: ["alchemy-grpc.example.com"],
  description: "grpc route a",
  rules: [
    {
      action: {
        retryPolicy: {
          retryConditions: ["cancelled"],
          numRetries: 1,
        },
      },
    },
  ],
});
export const ProbeHttpRoute = GCP.NetworkServices.HttpRoute("ProbeHttpRoute", {
  location: "global",
  hostnames: ["alchemy-http.example.com"],
  description: "http route a",
  rules: [
    {
      matches: [{ prefixMatch: "/" }],
      action: {
        redirect: {
          hostRedirect: "example.com",
          httpsRedirect: true,
        },
      },
    },
  ],
});
export const ProbeMesh = GCP.NetworkServices.Mesh("ProbeMesh", {
  location: "global",
  description: "mesh a",
  interceptionPort: 15001,
});
export const ProbeServiceBinding = GCP.NetworkServices.ServiceBinding("ProbeServiceBinding", {
  location: "global",
  description: "binding a",
});
export const ProbeServiceLbPolicy = GCP.NetworkServices.ServiceLbPolicy("ProbeServiceLbPolicy", {
  location: "global",
  description: "lb policy a",
  loadBalancingAlgorithm: "SPRAY_TO_REGION",
  autoCapacityDrain: { enable: true },
});

export const ProbeEndpointPolicy = GCP.NetworkServices.EndpointPolicy("ProbeEndpointPolicy", {
  location: "global",
  type: "SIDECAR_PROXY",
  endpointMatcher: {
    metadataLabelMatcher: {
      metadataLabelMatchCriteria: "MATCH_ANY",
      metadataLabels: [{ labelName: "app", labelValue: "probe" }],
    },
  },
  trafficPortSelector: { ports: ["8080"] },
});
export const ProbeTcpRoute = Effect.gen(function* () {
  const mesh = yield* ProbeMesh;
  return yield* GCP.NetworkServices.TcpRoute("ProbeTcpRoute", {
    location: "global",
    meshes: [mesh.name],
    rules: [
      { matches: [{ address: "0.0.0.0/0", port: "443" }], action: { originalDestination: true } },
    ],
  });
});
export const ProbeAuthzExtension = Effect.gen(function* () {
  const health = yield* GCP.Compute.RegionHealthCheck("ProbeAuthzHc", {
    region: "us-central1",
    type: "HTTP",
    httpHealthCheck: { port: 80 },
  });
  const backend = yield* GCP.Compute.RegionBackendService("ProbeAuthzBe", {
    region: "us-central1",
    protocol: "HTTP2",
    loadBalancingScheme: "INTERNAL_MANAGED",
    healthChecks: [health.selfLink.as<string>()],
  });
  return yield* GCP.NetworkServices.AuthzExtension("ProbeAuthzExtension", {
    location: "us-central1",
    service: backend.selfLink.as<string>(),
    authority: "authz.example.com",
    timeout: "0.1s",
    loadBalancingScheme: "INTERNAL_MANAGED",
  });
});
export const ProbeTlsRoute = Effect.gen(function* () {
  const mesh = yield* ProbeMesh;
  const backend = yield* GCP.Compute.BackendService("ProbeTlsBackend", {
    loadBalancingScheme: "INTERNAL_SELF_MANAGED",
    protocol: "HTTP",
  });
  return yield* GCP.NetworkServices.TlsRoute("ProbeTlsRoute", {
    location: "global",
    meshes: [mesh.name],
    rules: [
      {
        matches: [{ sniHost: ["api.example.com"], alpn: ["h2"] }],
        action: { destinations: [{ serviceName: backend.selfLink ?? backend.name, weight: 1 }] },
      },
    ],
  });
});
