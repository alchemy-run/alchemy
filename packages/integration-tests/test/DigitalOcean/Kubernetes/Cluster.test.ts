import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getKubernetesCluster, getKubernetesNodePool } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isGone, logLevel, skipSlow, testName } from "../support.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(DigitalOcean.providers(), Kubernetes.providers()),
});

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:kubernetes", "live"];
// A cluster takes five to ten minutes, and a node pool a few more.
const LIVE_TIMEOUT = 2_400_000;

test.provider.skipIf(skipSlow)(
  "cluster: create, apply a manifest through its connection, add and scale a node pool, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const configMapName = testName(stack.stage, "config").slice(0, 63);

      const declare = (extraNodes: number, value: string) =>
        Effect.gen(function* () {
          const cluster = yield* DigitalOcean.Kubernetes.Cluster("K8s", {
            region: "nyc3",
            nodePool: { size: "s-2vcpu-4gb", count: 1 },
          });
          const pool = yield* DigitalOcean.Kubernetes.NodePool("Extra", {
            clusterId: cluster.clusterId,
            size: "s-1vcpu-2gb",
            count: extraNodes,
            labels: { pool: "extra" },
          });
          yield* Kubernetes.Manifest("Config", {
            cluster,
            manifest: {
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: { name: configMapName, namespace: "default" },
              data: { greeting: value },
            },
          });
          return { cluster, pool };
        });

      const created = yield* stack.deploy(declare(1, "hello"));
      expect(created.cluster.status).toEqual("running");
      expect(created.cluster.endpoint).toMatch(/^https:\/\//);
      expect(created.cluster.connection.auth).toEqual({
        kind: "digitalocean-doks",
        clusterId: created.cluster.clusterId,
      });
      expect(created.pool.count).toEqual(1);

      const scaled = yield* stack.deploy(declare(2, "hi"));
      expect(scaled.pool.nodePoolId).toEqual(created.pool.nodePoolId);
      const pool = yield* getKubernetesNodePool({
        cluster_id: created.cluster.clusterId,
        node_pool_id: created.pool.nodePoolId,
      });
      expect(pool.node_pool.count).toEqual(2);

      yield* stack.destroy();

      expect(yield* isGone(getKubernetesCluster({ cluster_id: created.cluster.clusterId }))).toBe(
        true,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
