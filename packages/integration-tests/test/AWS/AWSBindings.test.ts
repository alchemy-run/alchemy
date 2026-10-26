import * as AWS from "@alchemy.run/aws";
import { runsAsRole } from "@alchemy.run/aws/AWSBindings";
import { describe, expect, it } from "@alchemy.run/test";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("AWSBindings.runsAsRole", { tags: ["unit", "provider:aws", "local"] }, () => {
  it("accepts Lambda, ECS and EC2", () => {
    for (const Type of ["AWS.Lambda.Function", "AWS.ECS.Task", "AWS.EC2.Instance"]) {
      expect(runsAsRole(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on EKS (Pod Identity)", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    expect(runsAsRole(host("Kubernetes.Deployment", { cluster: eks }))).toBe(true);
    expect(
      runsAsRole(
        host("Kubernetes.Job", { cluster: { auth: { kind: "aws-eks", clusterName: "c" } } }),
      ),
    ).toBe(true);
    expect(
      runsAsRole(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "aws-eks", clusterName: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on an EKS cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* AWS.EKS.Cluster.ref("Cluster");
      expect(runsAsRole(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [gke, local, kubeconfig, undefined]) {
      expect(runsAsRole(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects AWS resources that run no code as a role", () => {
    expect(runsAsRole(host("AWS.S3.Bucket"))).toBe(false);
    // A MicroVM image has no role of its own; RunMicrovm takes one per launch.
    expect(runsAsRole(host("AWS.Lambda.MicrovmImage"))).toBe(false);
  });

  it("rejects hosts outside AWS", () => {
    expect(runsAsRole(host("Neon.Function"))).toBe(false);
    expect(runsAsRole(host("Cloudflare.Worker"))).toBe(false);
  });
});
