import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS";
import { Bind, runsAsRole } from "@/AWS/AWSBindings.ts";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider.ts";
import type { ResourceLike } from "@/Resource.ts";
import { type BaseRuntimeContext, RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";

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

// Providers are never called: only declaration/registration runs.
const unused = {
  list: () => Effect.die("unused"),
  reconcile: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
};
const identityProviders = Layer.effect(
  AWS.Providers,
  Provider.collection([AWS.IAM.User, AWS.IAM.AccessKey, AWS.IAM.Role]),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Provider.succeed(AWS.IAM.User, unused),
      Provider.succeed(AWS.IAM.AccessKey, unused),
      Provider.succeed(AWS.IAM.Role, unused),
    ),
  ),
);

const makeRuntime = (): BaseRuntimeContext => {
  const env: Record<string, unknown> = {};
  return {
    Type: "Test.Host",
    id: "Api",
    env,
    get: (key) => Effect.sync(() => env[key] as any),
    set: (key, output) =>
      Effect.sync(() => {
        env[key] = output;
        return key;
      }),
  };
};

describe("AWSBindings.Bind", { tags: ["unit", "provider:aws", "local"] }, () => {
  // Regression for #2306: a plan/deploy re-runs a host's init with a fresh
  // `RuntimeContext` while handing back the same host object; every pass must
  // bind the created key, role ARN and region onto the new context.
  it("binds the created key onto every init pass of the same host", async () => {
    const stack = { name: "repro", stage: "test", resources: {}, bindings: {}, actions: {} };
    const worker = host("Cloudflare.Worker");
    const envKeys: string[][] = [];

    await Effect.gen(function* () {
      for (let pass = 0; pass < 2; pass++) {
        const runtime = makeRuntime();
        yield* Effect.gen(function* () {
          const bind = yield* Bind;
          yield* bind`AWS.S3.GetObject(${"Bucket"})`({
            policyStatements: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] }],
          });
        }).pipe(
          Effect.provideService(Alchemy.Stack, stack as any),
          Effect.provideService(RuntimeContext, runtime),
          Effect.provideService(Self, worker as any),
          Effect.provide(identityProviders),
        );
        envKeys.push(Object.keys(runtime.env).sort());
      }
    }).pipe(Effect.scoped, Effect.runPromise);

    expect(envKeys[0]).toEqual([
      "ALCHEMY_AWS_ACCESS_KEY_ID",
      "ALCHEMY_AWS_REGION",
      "ALCHEMY_AWS_ROLE_ARN",
      "ALCHEMY_AWS_SECRET_ACCESS_KEY",
    ]);
    expect(envKeys[1]).toEqual(envKeys[0]);
  });
});
