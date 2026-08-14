import { InstanceId } from "@/InstanceId.ts";
import * as Kubernetes from "@/Kubernetes";
import type { ClusterAdapterService } from "@/Kubernetes/ClusterAdapter.ts";
import { isDeploymentRolloutComplete } from "@/Kubernetes/Deployment.ts";
import {
  resolveWorkloadImage,
  usesManagedRegistry,
  workloadImageHash,
} from "@/Kubernetes/internal/workload.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const unitStack: Omit<StackSpec, "output"> = {
  name: "kubernetes-image-test",
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

const checkImageTypeSurface = () => {
  const cluster = undefined as unknown as Kubernetes.ClusterLike;
  const stringProps: Kubernetes.ImageDeploymentProps = {
    cluster,
    image: "registry.example.test/cache:v1",
  };
  const refProps: Kubernetes.ImageDeploymentProps = {
    cluster,
    image: Kubernetes.Image.ref("registry.example.test/cache@sha256:abc"),
  };
  const producedProps: Kubernetes.ImageDeploymentProps = {
    cluster,
    image: { imageUri: "2956.dkr.ecr.us-east-1.amazonaws.com/apps:hash" },
  };
  const bundledProps: Kubernetes.BundledDeploymentProps = {
    cluster,
    main: import.meta.url,
    image: "oven/bun:1",
  };
  return { stringProps, refProps, producedProps, bundledProps };
};
void checkImageTypeSurface;

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
  id: "ImageRefTest",
  source,
  platform: "linux/amd64",
  bootstrap: () => "",
  tags: {},
  state: { kind: "aws-ecr", repositoryName: "previous-repository" },
  session: { note: () => Effect.void },
});

describe("Kubernetes.Image.ref", () => {
  it.effect(
    "mirrors a pre-built image string through the managed registry",
    () =>
      provideAdapterLifecycle(
        Effect.gen(function* () {
          const calls: string[] = [];
          const source = { image: "registry.example.test/cache:v1" };
          expect(usesManagedRegistry(source)).toBe(true);
          const resolved = yield* resolveWorkloadImage(
            imageOptions(makeRegistryAdapter(calls), source),
          );
          expect(calls).toEqual(["resolve"]);
          expect(resolved.imageUri).toBe(
            "managed.example.test/repository:latest",
          );
          expect(resolved.cleanupState).toBeUndefined();
        }),
      ),
  );

  it.effect("uses Image.ref verbatim without invoking the registry", () =>
    provideAdapterLifecycle(
      Effect.gen(function* () {
        const calls: string[] = [];
        const previous = {
          kind: "aws-ecr",
          repositoryName: "previous-repository",
        };
        const source = {
          image: Kubernetes.Image.ref("registry.example.test/cache@sha256:abc"),
        };
        expect(usesManagedRegistry(source)).toBe(false);
        const resolved = yield* resolveWorkloadImage({
          ...imageOptions(makeRegistryAdapter(calls), source),
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

  it.effect(
    "uses a produced imageUri verbatim without invoking the registry",
    () =>
      provideAdapterLifecycle(
        Effect.gen(function* () {
          const calls: string[] = [];
          const source = {
            image: {
              imageUri: "2956.dkr.ecr.us-east-1.amazonaws.com/apps@sha256:def",
            },
          };
          expect(usesManagedRegistry(source)).toBe(false);
          const resolved = yield* resolveWorkloadImage(
            imageOptions(makeRegistryAdapter(calls), source),
          );
          expect(calls).toEqual([]);
          expect(resolved.imageUri).toBe(
            "2956.dkr.ecr.us-east-1.amazonaws.com/apps@sha256:def",
          );
          expect(resolved.state).toBeUndefined();
        }),
      ),
  );

  it.effect("hashes Image.ref without invoking the managed registry", () =>
    provideAdapterLifecycle(
      Effect.gen(function* () {
        const calls: string[] = [];
        const hash = yield* workloadImageHash({
          adapter: makeRegistryAdapter(calls),
          source: {
            image: Kubernetes.Image.ref("registry.example.test/cache:v2"),
          },
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
