import * as Docker from "@alchemy.run/docker";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { FRONT_NODE_PORT, FRONT_PORT, Kind } from "./fixtures/kubernetes/cluster.ts";
import { CounterLive } from "./fixtures/kubernetes/counter-live.ts";
import Front, { FRONT_NAME } from "./fixtures/kubernetes/front.ts";

const testOptions = {
  providers: Layer.mergeAll(Kubernetes.providers(), Docker.providers(), Rivet.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetKubernetesConformance", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane and a pool on a local kind cluster, called from a
// Deployment on the same cluster.
describe.skipIf(!!process.env.FAST)(
  "Rivet on Kubernetes",
  { tags: ["provider:rivet", "provider:kubernetes", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
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
            return { front: front.deploymentName };
          }).pipe(Effect.provide(CounterLive)),
        );
        expect(outputs.front).toBe(FRONT_NAME);
        yield* waitForReady(baseUrl, { attempts: 60, base: "3 seconds" });
      }),
      { timeout: 900_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    conformanceTests(test, { baseUrl: () => baseUrl });
  },
);
