import * as Docker from "@alchemy.run/docker";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Rivet from "@alchemy.run/rivet";
import { Cluster as RivetCluster } from "@alchemy.run/rivet/Cluster";
import * as RivetKubernetes from "@alchemy.run/rivet/Kubernetes";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { kubectlGet, type KindCluster } from "../Kubernetes/fixtures/kind.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import {
  Cluster,
  CONTROL_PLANE_PORT,
  FRONT_NODE_PORT,
  FRONT_PORT,
  Kind,
} from "./fixtures/kubernetes/cluster.ts";
import { CounterLive } from "./fixtures/kubernetes/counter-live.ts";
import Front, { FRONT_NAME } from "./fixtures/kubernetes/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = {
  providers: Layer.mergeAll(Kubernetes.providers(), Docker.providers(), Rivet.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetKubernetesConformance", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;
let rust: RustTarget;
let kind: KindCluster;

// A Rust Durable Object on a pool of its own, reporting node version 2.
const RustPool = RivetKubernetes.DeploymentPool("Rust", { version: 2 }).pipe(
  Layer.provide(Cluster),
);

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane and a pool on a local kind cluster, called from a
// Deployment on the same cluster.
describe.skipIf(!!process.env.FAST)(
  "Rivet on Kubernetes",
  { tags: ["provider:rivet", "provider:kubernetes", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Kind;
            const front = yield* Front;
            // Publish the front on the node port kind maps to the host.
            yield* Kubernetes.Manifest("RivetKubeFrontNodePort", {
              cluster,
              manifest: {
                apiVersion: "v1",
                kind: "Service",
                metadata: { name: `${FRONT_NAME}-public`, namespace: "default" },
                spec: {
                  type: "NodePort",
                  selector: { "app.kubernetes.io/name": FRONT_NAME },
                  ports: [{ port: 3000, targetPort: 3000, nodePort: FRONT_NODE_PORT }],
                },
              },
            });
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { front: front.deploymentName, rust: rustTarget(actors), kind: cluster };
          }).pipe(Effect.provide(CounterLive)),
        );
        expect(outputs.front).toBe(FRONT_NAME);
        rust = outputs.rust as RustTarget;
        kind = outputs.kind as KindCluster;
        yield* waitForReady(baseUrl, { attempts: 60, base: "3 seconds" });
      }),
      { timeout: 900_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "local" });
    test(
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "every node reads the control plane's token from a Secret, never its pod template",
      Effect.gen(function* () {
        const deployments = (yield* kubectlGet(kind, ["deployments", "--namespace", "default"]))
          .items as Array<{
          metadata: { name: string };
          spec: { template: { spec: { containers: Array<{ env?: Array<any> }> } } };
        }>;
        // The pools' nodes: Default, Services and Rust.
        const nodes = deployments.filter((deployment) =>
          (deployment.spec.template.spec.containers[0]?.env ?? []).some(
            (entry) => entry.name === "RIVET_TOKEN",
          ),
        );
        expect(nodes.length).toBe(3);
        for (const node of nodes) {
          const token = node.spec.template.spec.containers[0]!.env!.find(
            (entry) => entry.name === "RIVET_TOKEN",
          );
          expect(token.value).toBeUndefined();
          expect(token.valueFrom.secretKeyRef).toEqual({
            name: `${node.metadata.name}-env`,
            key: "RIVET_TOKEN",
          });
        }
      }).pipe(Effect.provide(PlatformServices)),
      { timeout: 60_000 },
    );

    test(
      "a pool's nodes report the version it sets, and only that pool's",
      Effect.gen(function* () {
        const deployments = (yield* kubectlGet(kind, ["deployments", "--namespace", "default"]))
          .items as Array<{
          metadata: { name: string };
          spec: { template: { spec: { containers: Array<{ env?: Array<any> }> } } };
        }>;
        // Physical names are hashed: tell the pools' nodes apart by their env.
        const versions = deployments
          .map((deployment) => deployment.spec.template.spec.containers[0]?.env ?? [])
          .filter((env) => env.some((entry) => entry.name === "RIVET_TOKEN"))
          .map((env) => env.find((entry) => entry.name === "RIVET_NODE_VERSION")?.value);
        // Default, Services and Rust: only the Rust pool sets a version.
        expect(versions.sort()).toEqual(["2", undefined, undefined]);
      }).pipe(Effect.provide(PlatformServices)),
      { timeout: 60_000 },
    );

    // A second control plane whose engines can't reach their object storage
    // or be reached from here: deploy only its StatefulSet (with the Secret
    // and token it reads), and check what landed in the cluster.
    test.provider(
      "a control plane keeps its object storage credentials in its Secret",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          yield* stack.deploy(
            Effect.gen(function* () {
              yield* RivetCluster;
            }).pipe(
              Effect.provide(
                RivetKubernetes.StatefulSetControlPlane("Stored", {
                  cluster: kind,
                  name: "rivet-stored",
                  expose: { type: "ClusterIP", endpoint: "http://rivet-stored.invalid:6420" },
                  objectStorage: {
                    kind: "s3",
                    bucket: "rivet",
                    region: "us-east-1",
                    endpoint: "https://storage.invalid",
                    accessKeyId: "AKIDEXAMPLE",
                    secretAccessKey: Redacted.make("storage-secret-sentinel"),
                  },
                }),
              ),
            ),
            { include: ["StoredEngines"] },
          );
          const engines = yield* kubectlGet(kind, [
            "statefulset",
            "rivet-stored",
            "--namespace",
            "default",
          ]);
          const env = engines.spec.template.spec.containers[0].env as Array<any>;
          expect(JSON.stringify(env)).not.toContain("sentinel");
          expect(
            env.find(
              (entry) => entry.name === "RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY",
            ).valueFrom.secretKeyRef,
          ).toEqual({ name: "rivet-stored-token", key: "secret-access-key" });
          const secret = yield* kubectlGet(kind, [
            "secret",
            "rivet-stored-token",
            "--namespace",
            "default",
          ]);
          expect(Buffer.from(secret.data["secret-access-key"], "base64").toString("utf8")).toBe(
            "storage-secret-sentinel",
          );
          yield* stack.destroy();
          expect(
            yield* kubectlGet(kind, ["statefulset", "rivet-stored", "--namespace", "default"]),
          ).toBeUndefined();
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 180_000 },
    );

    test(
      "a Rust Durable Object runs on a Deployment pool",
      Effect.gen(function* () {
        // The attribute is the in-cluster address callers in the cluster use;
        // from this machine, the control plane is on kind's published port.
        yield* expectRustCounter(
          { ...rust, endpoint: `http://localhost:${CONTROL_PLANE_PORT}` },
          "kubernetes-rust",
        );
      }),
      { timeout: 300_000 },
    );
  },
);
