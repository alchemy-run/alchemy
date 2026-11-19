import * as Docker from "@alchemy.run/docker";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetKubernetes from "@alchemy.run/rivet/Kubernetes";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
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

// A Rust Durable Object on a pool of its own.
const RustPool = RivetKubernetes.DeploymentPool("Rust").pipe(Layer.provide(Cluster));

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
            return { front: front.deploymentName, rust: rustTarget(actors) };
          }).pipe(Effect.provide(CounterLive)),
        );
        expect(outputs.front).toBe(FRONT_NAME);
        rust = outputs.rust as RustTarget;
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
