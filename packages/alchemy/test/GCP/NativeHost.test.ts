import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as GCP from "@/GCP";
import { isNativeHost } from "@/GCP/NativeHost.ts";
import type { ResourceLike } from "@/Resource.ts";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("GCP isNativeHost", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("accepts GCP platforms", () => {
    for (const Type of [
      "GCP.Run.Service",
      "GCP.Run.Job",
      "GCP.Run.WorkerPool",
      "GCP.CloudFunctions.Function",
    ]) {
      expect(isNativeHost(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on GKE, whose grants go to the cluster adapter", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    expect(isNativeHost(host("Kubernetes.Deployment", { cluster: gke }))).toBe(true);
    expect(
      isNativeHost(
        host("Kubernetes.Job", { cluster: { auth: { kind: "gcp-gke", cluster: "c" } } }),
      ),
    ).toBe(true);
    expect(
      isNativeHost(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "gcp-gke", cluster: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on a GKE cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* GCP.Container.Cluster.ref("Cluster");
      expect(isNativeHost(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [eks, local, kubeconfig, undefined]) {
      expect(isNativeHost(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects external hosts, GCP resources that aren't platforms, and no host", () => {
    expect(isNativeHost(host("Cloudflare.Worker"))).toBe(false);
    expect(isNativeHost(host("AWS.Lambda.Function"))).toBe(false);
    expect(isNativeHost(host("GCP.Storage.Bucket"))).toBe(false);
    expect(isNativeHost(undefined)).toBe(false);
  });
});
