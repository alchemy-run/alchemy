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
