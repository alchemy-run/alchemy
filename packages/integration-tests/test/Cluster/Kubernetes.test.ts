import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "./conformance.ts";
import { FRONT_NODE_PORT, FRONT_PORT, Kind } from "./fixtures/kubernetes/cluster.ts";
import Front, { FRONT_NAME } from "./fixtures/kubernetes/front.ts";
import { Lives } from "./fixtures/kubernetes/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = {
  providers: Layer.mergeAll(Kubernetes.providers(), Docker.providers(), Cluster.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterKubernetes", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;

// The Effect Cluster conformance cases, against Postgres and runners on a
// local kind cluster, called from a Deployment on the same cluster.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Kubernetes",
  { tags: ["provider:cluster", "provider:kubernetes", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Kind;
            const front = yield* Front;
            // Publish the front on the node port kind maps to the host.
            yield* Kubernetes.Manifest("ClusterKubeFrontNodePort", {
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
          }).pipe(Effect.provide(Lives)),
        );
        expect(outputs.front).toBe(FRONT_NAME);
        yield* waitForReady(baseUrl);
      }),
      { timeout: 900_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "local" });
  },
);
