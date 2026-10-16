import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as AWS from "@/AWS";
import { isNativeHost } from "@/AWS/NativeHost.ts";
import type { ResourceLike } from "@/Resource.ts";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("isNativeHost", { tags: ["unit", "provider:aws", "local"] }, () => {
  it("accepts AWS platforms", () => {
    for (const Type of ["AWS.Lambda.Function", "AWS.ECS.Task", "AWS.EC2.Instance"]) {
      expect(isNativeHost(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on EKS, whose grants go to the cluster adapter", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    expect(isNativeHost(host("Kubernetes.Deployment", { cluster: eks }))).toBe(true);
    expect(
      isNativeHost(
        host("Kubernetes.Job", { cluster: { auth: { kind: "aws-eks", clusterName: "c" } } }),
      ),
    ).toBe(true);
    expect(
      isNativeHost(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "aws-eks", clusterName: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on an EKS cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* AWS.EKS.Cluster.ref("Cluster");
      expect(isNativeHost(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [gke, local, kubeconfig, undefined]) {
      expect(isNativeHost(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects AWS resources that aren't platforms", () => {
    expect(isNativeHost(host("AWS.S3.Bucket"))).toBe(false);
    // A MicroVM image has no role of its own: it reaches AWS as an external host.
    expect(isNativeHost(host("AWS.Lambda.MicrovmImage"))).toBe(false);
  });

  it("rejects external hosts and no host", () => {
    expect(isNativeHost(host("Neon.Function"))).toBe(false);
    expect(isNativeHost(undefined)).toBe(false);
  });
});
