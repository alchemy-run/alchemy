import * as GCP from "@alchemy.run/gcp";
import { runsAsServiceAccount } from "@alchemy.run/gcp/GCPBindings";
import { describe, expect, it } from "alchemy-test";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("GCPBindings.runsAsServiceAccount", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("accepts Cloud Run and Cloud Functions", () => {
    for (const Type of [
      "GCP.Run.Service",
      "GCP.Run.Job",
      "GCP.Run.WorkerPool",
      "GCP.CloudFunctions.Function",
    ]) {
      expect(runsAsServiceAccount(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on GKE (Workload Identity)", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster: gke }))).toBe(true);
    expect(
      runsAsServiceAccount(
        host("Kubernetes.Job", { cluster: { auth: { kind: "gcp-gke", cluster: "c" } } }),
      ),
    ).toBe(true);
    expect(
      runsAsServiceAccount(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "gcp-gke", cluster: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on a GKE cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* GCP.Container.Cluster.ref("Cluster");
      expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [eks, local, kubeconfig, undefined]) {
      expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects hosts outside GCP and GCP resources that run no code", () => {
    expect(runsAsServiceAccount(host("Cloudflare.Worker"))).toBe(false);
    expect(runsAsServiceAccount(host("AWS.Lambda.Function"))).toBe(false);
    expect(runsAsServiceAccount(host("GCP.Storage.Bucket"))).toBe(false);
  });
});
