import * as GCP from "@alchemy.run/gcp";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Private, Secretive } from "./fixtures/cloud-run-plan.ts";
import { planCluster } from "./fixtures/plan-cluster.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Rivet.providers()) };
const { test } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "RivetCloudRunPoolPlan", import.meta.url);

const gcp = {
  kind: "gcp",
  network: "rivet",
  subnetwork: "rivet-us",
  region: "us-central1",
} as const;

type Node = {
  resource: { Type: string; LogicalId: string };
  props: Record<string, any>;
  bindings: Array<{ sid: string }>;
};

/** The resources a plan of `object` declares, on a control plane with a private address. */
const planned = (object: Effect.Effect<unknown, never, any>) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(
      Effect.asVoid(object).pipe(
        Effect.provide(
          planCluster({
            endpoint: "https://rivet.example.com",
            nodeEndpoint: "http://10.0.0.2:6420",
            network: gcp,
          }),
        ),
      ),
    );
    return Object.values(plan.resources) as Node[];
  });

// The whole CloudRunPool Layer, planned with the GCP providers: nothing is
// created and no GCP API is called.
describe("RivetGCP.CloudRunPool plan", { tags: ["unit", "provider:rivet"] }, () => {
  test(
    "a pool with secrets and no account of its own grants them through its worker pool",
    Effect.gen(function* () {
      const nodes = yield* planned(Secretive);
      const workerPool = nodes.find((node) => node.resource.Type === "GCP.Run.WorkerPool");
      expect(workerPool?.props.template).not.toHaveProperty("serviceAccount");
      expect(workerPool?.bindings.map((binding) => binding.sid)).toContain(
        "RivetGCP.CloudRunPool.secrets(Secrets)",
      );
      // No account of the pool's own, and no grant outside the worker pool.
      expect(nodes.map((node) => node.resource.Type)).not.toContain("GCP.IAM.ServiceAccount");
      expect(nodes.map((node) => node.resource.Type)).not.toContain("GCP.IAM.Member");
    }),
    { timeout: 60_000 },
  );

  test(
    "a pool told to join the control plane's network sends private traffic through it",
    Effect.gen(function* () {
      const nodes = yield* planned(Private);
      const workerPool = nodes.find((node) => node.resource.Type === "GCP.Run.WorkerPool");
      expect(workerPool?.props.location).toBe("us-central1");
      expect(workerPool?.props.template.vpcAccess).toEqual({
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{ network: "rivet", subnetwork: "rivet-us" }],
      });
    }),
    { timeout: 60_000 },
  );

  test(
    "a pool not told to join keeps the template it always had",
    Effect.gen(function* () {
      const nodes = yield* planned(Secretive);
      const workerPool = nodes.find((node) => node.resource.Type === "GCP.Run.WorkerPool");
      expect(workerPool?.props.template).not.toHaveProperty("vpcAccess");
    }),
    { timeout: 60_000 },
  );
});
