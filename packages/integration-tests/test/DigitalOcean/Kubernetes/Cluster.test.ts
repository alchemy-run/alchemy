import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getKubernetesCluster,
  getKubernetesNodePool,
  getMonitoringSink,
  getTag,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestRegistry } from "../fixtures/app/shared.ts";
import { isGone, logLevel, skipSlow, testName } from "../support.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(DigitalOcean.providers(), Kubernetes.providers()),
});

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:kubernetes", "live"];
// A cluster takes five to ten minutes, and a node pool a few more.
const LIVE_TIMEOUT = 2_400_000;

test.provider.skipIf(skipSlow)(
  "cluster: create, apply a manifest, forward its logs, add and scale a node pool, enable the registry, install a 1-Click app, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const configMapName = testName(stack.stage, "config").slice(0, 63);

      const declare = (
        extraNodes: number,
        value: string,
        registryEnabled: boolean,
        oneClickApps?: string[],
      ) =>
        Effect.gen(function* () {
          yield* TestRegistry;
          const cluster = yield* DigitalOcean.Kubernetes.Cluster("K8s", {
            region: "nyc3",
            nodePool: { size: "s-2vcpu-4gb", count: 1 },
            registryEnabled,
            oneClickApps,
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
          // The cluster's logs, forwarded to an external OpenSearch endpoint
          // (DigitalOcean stores it without connecting).
          const logs = yield* DigitalOcean.Monitoring.Destination("Logs", {
            opensearch: {
              endpoint: "https://opensearch.example.com:9200",
              username: "alchemy",
              password: "not-a-real-password",
            },
          });
          const sink = yield* DigitalOcean.Monitoring.Sink("LogSink", {
            destinationId: logs.destinationId,
            resources: [{ urn: cluster.urn, name: "k8s" }],
          });
          return { cluster, pool, sinkId: sink.sinkId };
        });

      const created = yield* stack.deploy(declare(1, "hello", false));
      expect(created.cluster.status).toEqual("running");
      expect(created.cluster.endpoint).toMatch(/^https:\/\//);
      expect(created.cluster.connection.auth).toEqual({
        kind: "digitalocean-doks",
        clusterId: created.cluster.clusterId,
      });
      expect(created.pool.count).toEqual(1);
      const sink = yield* getMonitoringSink({ sink_uuid: created.sinkId });
      expect(sink.sink.resources?.[0]?.urn).toEqual(created.cluster.urn);

      const scaled = yield* stack.deploy(declare(2, "hi", true, ["metrics-server"]));
      expect(scaled.cluster.oneClickApps).toEqual(["metrics-server"]);
      expect(scaled.pool.nodePoolId).toEqual(created.pool.nodePoolId);
      const pool = yield* getKubernetesNodePool({
        cluster_id: created.cluster.clusterId,
        node_pool_id: created.pool.nodePoolId,
      });
      expect(pool.node_pool.count).toEqual(2);
      // The registry integration turned on in place.
      const live = yield* getKubernetesCluster({ cluster_id: created.cluster.clusterId });
      expect(live.kubernetes_cluster.registry_enabled).toBe(true);
      const ownTags = (live.kubernetes_cluster.tags ?? []).filter((t) => t.startsWith("alchemy:"));
      expect(ownTags.length).toBeGreaterThan(0);

      yield* stack.destroy();

      expect(yield* isGone(getKubernetesCluster({ cluster_id: created.cluster.clusterId }))).toBe(
        true,
      );
      expect(yield* isGone(getMonitoringSink({ sink_uuid: created.sinkId }))).toBe(true);
      // The cluster's ownership and generation tags go with it.
      for (const tag of ownTags) expect(yield* isGone(getTag({ tag_id: tag }))).toBe(true);
    }).pipe(logLevel),
  // The team's one registry is declared here, so hold the registry lock.
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT, exclusive: "digitalocean:registry" },
);
