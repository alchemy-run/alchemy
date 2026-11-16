import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import type { ClusterShape, ControlPlaneProps } from "@alchemy.run/rivet/Cluster";
import { nodesNetwork } from "@alchemy.run/rivet/GCP/CloudRunPool";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { planCluster } from "./fixtures/plan-cluster.ts";
import { Plain } from "./fixtures/pool-plan.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "RivetPrivateControlPlanePlan", import.meta.url);

const token = Redacted.make("token");
const props: ControlPlaneProps = {
  endpoint: "https://rivet.example.com",
  token,
  namespace: "default",
};
const docker = { kind: "docker", name: "rivet" } as const;
const gcp = {
  kind: "gcp",
  network: "rivet",
  subnetwork: "rivet-us",
  region: "us-central1",
} as const;

/** The cluster `Rivet.ControlPlane` gives its pools. */
const clusterOf = (props: ControlPlaneProps) =>
  Effect.gen(function* () {
    return yield* Rivet.Cluster;
  }).pipe(Effect.provide(Rivet.ControlPlane("Rivet", props))) as Effect.Effect<ClusterShape>;

/** The environment and networks of the nodes a plan of `Plain` declares on `cluster`. */
const nodesOf = (cluster: Omit<ClusterShape, "token" | "namespace">) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(Effect.asVoid(Plain).pipe(Effect.provide(planCluster(cluster))));
    const nodes = Object.values(plan.resources) as Array<{
      resource: { Type: string };
      props: { environment?: Record<string, unknown>; networks?: unknown };
    }>;
    const service = nodes.find((node) => node.resource.Type === "Docker.Service");
    return { environment: service?.props.environment, networks: service?.props.networks };
  });

describe("Rivet.ControlPlane", { tags: ["unit", "provider:rivet"] }, () => {
  it.effect("a control plane given no private address is the cluster it always was", () =>
    Effect.gen(function* () {
      const cluster = yield* clusterOf(props);
      expect(Object.keys(cluster).sort()).toEqual(["endpoint", "namespace", "token"]);
    }),
  );

  it.effect("a control plane's private address and network reach its pools", () =>
    Effect.gen(function* () {
      const cluster = yield* clusterOf({
        ...props,
        nodeEndpoint: "http://10.0.0.2:6420",
        network: gcp,
      });
      expect(cluster).toEqual({
        endpoint: "https://rivet.example.com",
        token,
        namespace: "default",
        nodeEndpoint: "http://10.0.0.2:6420",
        network: gcp,
      });
    }),
  );
});

describe("Rivet pool on a private control plane", { tags: ["unit", "provider:rivet"] }, () => {
  test(
    "nodes on the control plane's network connect to its private address",
    Effect.gen(function* () {
      const nodes = yield* nodesOf({
        endpoint: "https://rivet.example.com",
        nodeEndpoint: "http://10.0.0.2:6420",
        network: docker,
      });
      expect(nodes.environment).toMatchObject({ RIVET_ENDPOINT: "http://10.0.0.2:6420" });
      expect(nodes.networks).toEqual([{ name: "rivet" }]);
    }),
    { timeout: 60_000 },
  );

  test(
    "nodes on a network with no private address connect to the control plane's endpoint",
    Effect.gen(function* () {
      const nodes = yield* nodesOf({ endpoint: "https://rivet.example.com", network: docker });
      expect(nodes.environment).toMatchObject({ RIVET_ENDPOINT: "https://rivet.example.com" });
    }),
    { timeout: 60_000 },
  );
});

describe("RivetGCP.CloudRunPool network", { tags: ["unit", "provider:rivet"] }, () => {
  it("joins the control plane's GCP network, so its nodes get the private address, only with clusterNetwork", () => {
    const cluster = { network: gcp };
    // Joined: the cluster's own network, which makePoolLayer gives nodeEndpoint.
    expect(nodesNetwork({ clusterNetwork: true }, cluster)).toBe(gcp);
    // Not joined: a copy, so the nodes keep the public endpoint and the region.
    const copy = nodesNetwork({}, cluster);
    expect(copy).toEqual(gcp);
    expect(copy).not.toBe(gcp);
    // A cluster on no GCP network can't be joined.
    expect(nodesNetwork({ clusterNetwork: true }, {})).toBeUndefined();
    expect(nodesNetwork({ clusterNetwork: true }, { network: docker })).toBeUndefined();
  });

  it("without clusterNetwork, any other cluster network is used as it always was", () => {
    expect(nodesNetwork({}, {})).toEqual({ kind: "none" });
    expect(nodesNetwork({}, { network: docker })).toBe(docker);
  });
});
