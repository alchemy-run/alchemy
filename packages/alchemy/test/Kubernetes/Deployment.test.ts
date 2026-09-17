import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network.ts";
import { Cluster } from "@/AWS/EKS/Cluster.ts";
import { makeEksTransport } from "@/AWS/EKS/KubernetesAdapter.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Kubernetes from "@/Kubernetes";
import type { ClusterAdapterService } from "@/Kubernetes/ClusterAdapter.ts";
import { isDeploymentRolloutComplete } from "@/Kubernetes/Deployment.ts";
import { readObject } from "@/Kubernetes/internal/client.ts";
import {
  resolveWorkloadImage,
  workloadImageHash,
} from "@/Kubernetes/internal/workload.ts";
import * as Core from "@/Test/Core";
import * as Provider from "@/Provider";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as Test from "@/Test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EksHostApi from "./fixtures/deployment.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);

const unitStack: Omit<StackSpec, "output"> = {
  name: "kubernetes-deployment-test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};

const adapterLifecycleLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  Layer.succeed(Stack, unitStack),
  Layer.succeed(Stage, unitStack.stage),
  Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
);

const provideAdapterLifecycle = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Stack | Stage | InstanceId | FileSystem.FileSystem | Path.Path
  >,
) => effect.pipe(Effect.provide(adapterLifecycleLayer));

const checkImageStrategyTypeSurface = () => {
  const cluster = undefined as unknown as Kubernetes.ClusterLike;
  const imageProps: Kubernetes.ImageDeploymentProps = {
    cluster,
    image: "registry.example.test/cache:v1",
    imageStrategy: "direct",
  };
  const bundledProps: Kubernetes.BundledDeploymentProps = {
    cluster,
    main: import.meta.url,
    // @ts-expect-error direct delivery only applies to pre-built images
    imageStrategy: "direct",
  };
  return { imageProps, bundledProps };
};
void checkImageStrategyTypeSurface;

const makeRegistryAdapter = (calls: string[]): ClusterAdapterService => ({
  kind: "Kubernetes.ClusterAdapter",
  connect: () => Effect.die(new Error("not used")),
  registry: {
    resolve: () =>
      Effect.sync(() => {
        calls.push("resolve");
        return {
          imageUri: "managed.example.test/repository:latest",
          codeHash: "managed-hash",
          state: { kind: "aws-ecr", repositoryName: "repository" },
        } as any;
      }),
    hash: () =>
      Effect.sync(() => {
        calls.push("hash");
        return "managed-hash";
      }),
    delete: () => Effect.void,
  },
});

const imageOptions = (adapter: ClusterAdapterService, source: any) => ({
  adapter,
  id: "ImageStrategyTest",
  source,
  platform: "linux/amd64",
  bootstrap: () => "",
  tags: {},
  state: { kind: "aws-ecr", repositoryName: "previous-repository" },
  session: { note: () => Effect.void },
});

describe("Kubernetes Deployment image strategy", () => {
  it.effect("mirrors pre-built images by default", () =>
    provideAdapterLifecycle(
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolved = yield* resolveWorkloadImage(
          imageOptions(makeRegistryAdapter(calls), {
            image: "registry.example.test/cache:v1",
          }),
        );
        expect(calls).toEqual(["resolve"]);
        expect(resolved.imageUri).toBe(
          "managed.example.test/repository:latest",
        );
        expect(resolved.cleanupState).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "uses a pre-built image directly without invoking the registry",
    () =>
      provideAdapterLifecycle(
        Effect.gen(function* () {
          const calls: string[] = [];
          const previous = {
            kind: "aws-ecr",
            repositoryName: "previous-repository",
          };
          const resolved = yield* resolveWorkloadImage({
            ...imageOptions(makeRegistryAdapter(calls), {
              image: "registry.example.test/cache@sha256:abc",
            }),
            imageStrategy: "direct",
            state: previous,
          });
          expect(calls).toEqual([]);
          expect(resolved.imageUri).toBe(
            "registry.example.test/cache@sha256:abc",
          );
          expect(resolved.state).toBeUndefined();
          expect(resolved.cleanupState).toEqual(previous);
        }),
      ),
  );

  it.effect("hashes direct images without invoking the managed registry", () =>
    provideAdapterLifecycle(
      Effect.gen(function* () {
        const calls: string[] = [];
        const hash = yield* workloadImageHash({
          adapter: makeRegistryAdapter(calls),
          source: {
            image: "registry.example.test/cache:v2",
          },
          imageStrategy: "direct",
          platform: "linux/amd64",
          bootstrap: () => "",
        });
        expect(hash).toMatch(/^[a-f0-9]{16}$/);
        expect(calls).toEqual([]);
      }),
    ),
  );

  it("recognizes only a fully completed Kubernetes rollout", () => {
    const complete = {
      metadata: { generation: 4 },
      spec: { replicas: 2 },
      status: {
        observedGeneration: 4,
        replicas: 2,
        updatedReplicas: 2,
        availableReplicas: 2,
      },
    };
    expect(isDeploymentRolloutComplete(complete)).toBe(true);
    expect(
      isDeploymentRolloutComplete({
        ...complete,
        status: { ...complete.status, replicas: 3 },
      }),
    ).toBe(false);
    expect(
      isDeploymentRolloutComplete({
        ...complete,
        status: { ...complete.status, observedGeneration: 3 },
      }),
    ).toBe(false);
  });
});

// Ungated probe: `Deployment` is a composite host (in-cluster
// Deployment/Service plus adapter-owned cloud resources — ECR repo,
// pod-identity role, PodIdentityAssociation on EKS). It has no faithful
// single-API enumeration, so `list()` is intentionally empty. This probe
// proves the provider is registered, its record type-checks (a missing /
// mistyped `list` collapses Provider.of inference), and it runs live —
// without paying the ~15-minute EKS control-plane create.
test.provider(
  "list returns an empty array (composite host, not enumerable)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Deployment);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
);

// Full end-to-end (gated). An EKS Auto Mode cluster takes ~10–15 min to
// provision, plus image build/push, pod scheduling, and NLB provisioning —
// well beyond the routine speed-doctrine ceiling. Gate it behind AWS_TEST_SLOW.
//
// It deploys, in two phases (refs read committed stack state, not the in-flight
// plan): (1) a public network + a `compute: "auto"` cluster (the provider owns
// the cluster/node IAM roles); (2) the same infra + the `Deployment` fixture,
// which binds DynamoDB `PutItem`. The bound policy lands on the generated
// pod-identity role and the table name is injected into the pod; the pod
// resolves credentials via the EKS Pod Identity container-credentials chain.
// The test curls the LoadBalancer `/put` route, then asserts the item was
// written by reading it back out-of-band through the DynamoDB API — proving
// the binding, pod identity, image pipeline, and server-side-apply path in one
// shot.
//
// NOTE: this path has not been run green live in this factory wave (cluster
// create alone exceeds the agent budget). It is gated + skip-clean; run on an
// account with Auto Mode Pod Identity by setting AWS_TEST_SLOW=1.

// Cluster declared at a TOP-LEVEL logical id so the fixture can resolve it
// with `Cluster.ref("EksHostCluster")` (no namespace nesting). `compute:
// "auto"` exercises the AutoCluster fold-in: the provider creates and owns the
// cluster + node IAM roles.
const infra = Effect.gen(function* () {
  const network = yield* Network("EksHostNetwork", {
    cidrBlock: "10.84.0.0/16",
    availabilityZones: 2,
  });

  const cluster = yield* Cluster("EksHostCluster", {
    compute: "auto",
    resourcesVpcConfig: {
      subnetIds: network.publicSubnetIds,
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
    },
  });

  return { cluster, network };
});

const sharedStack = Core.scratchStack(testOptions, "EksServerHost");

describe.skipIf(!process.env.AWS_TEST_SLOW)("Kubernetes Deployment E2E", () => {
  let baseUrl: string;
  let helmRelease: Kubernetes.HelmChart["Attributes"];
  let helmCluster: Cluster["Attributes"];

  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Phase 1: cluster + network only.
      yield* sharedStack.deploy(infra);
      // Phase 2: same infra + the Deployment fixture (refs the cluster) +
      // a HelmChart rendering the local fixture chart onto the cluster.
      const { host, cluster, release } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const { cluster } = yield* infra;
          const release = yield* Kubernetes.HelmChart("E2EHelmChart", {
            cluster,
            chart: `${import.meta.dirname}/fixtures/chart`,
            values: { message: "helm-e2e", secondConfigMap: { enabled: true } },
          });
          const host = yield* EksHostApi;
          return { host, cluster, release };
        }),
      );
      helmRelease = release;
      helmCluster = cluster;
      // `url` is a full URL (`http://<nlb-hostname>:<port>` — the NLB
      // listener is the Service port, not 80).
      expect(host.url).toBeTruthy();
      baseUrl = host.url!.replace(/\/+$/, "");

      // NLB DNS + pod readiness ramp — retry /health.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health ${res.status}`)),
        ),
        Effect.tapError((e) => Effect.logWarning(String(e))),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 60 }),
      );
    }),
    // Cluster create (~18 min) + image build/push + Auto Mode node launch +
    // NLB provisioning/DNS + URL readiness poll (~5–10 min) routinely total
    // 35+ min end-to-end.
    { timeout: 2_700_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 600_000,
  });

  test.provider(
    "bound DynamoDB PutItem writes an item from inside the pod",
    () =>
      Effect.gen(function* () {
        // Deterministic id: the table is created fresh by this suite's deploy
        // (beforeAll starts with a destroy), so no stale item can pre-exist,
        // and a stable id keeps re-runs convergent instead of accreting items.
        const itemId = "eks-deployment-put-item";
        const res = yield* HttpClient.get(`${baseUrl}/put?id=${itemId}`).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
        expect(res.status).toBe(200);
        const body = (yield* res.json) as { written: string; table: string };
        expect(body.written).toBe(itemId);

        // Prove the binding actually reached DynamoDB: read the item back
        // out-of-band via the control-plane API.
        const got = yield* dynamodb
          .getItem({ TableName: body.table, Key: { pk: { S: itemId } } })
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
          );
        expect(got.Item?.pk?.S).toBe(itemId);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "HelmChart renders and applies its objects onto the cluster",
    () =>
      Effect.gen(function* () {
        // The chart rendered both ConfigMaps (the conditional one was
        // toggled on via values) into the default namespace.
        expect(helmRelease.objects).toHaveLength(2);
        expect(helmRelease.namespace).toBe("default");
        // The generic attributes persist the cluster connection for
        // adapter-based delete.
        expect(helmRelease.connection.auth.kind).toBe("aws-eks");

        // Read the primary ConfigMap back out-of-band through the
        // Kubernetes API and prove the values reached the cluster.
        const configRef = helmRelease.objects.find((object) =>
          object.name.endsWith("-config"),
        )!;
        expect(configRef).toBeDefined();
        const transport = yield* makeEksTransport({
          clusterName: helmCluster.clusterName,
          endpoint: helmCluster.endpoint!,
          certificateAuthorityData: helmCluster.certificateAuthorityData!,
        });
        const applied = (yield* readObject({
          transport,
          object: configRef,
        })) as { data?: Record<string, string> } | undefined;
        expect(applied?.data?.message).toBe("helm-e2e");
        expect(applied?.data?.release).toBe(helmRelease.releaseName);
      }),
    { timeout: 120_000 },
  );
});
