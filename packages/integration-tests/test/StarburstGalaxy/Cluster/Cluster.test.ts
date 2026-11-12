import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectGone, pinnedName, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";
import { expectFound } from "../lookup.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const REGION = "aws-us-east1";

const getCluster = (clusterId: string) => galaxy.cluster.getCluster({ clusterId, extended: true });

const clusterExists = (clusterId: string) =>
  getCluster(clusterId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create disabled, enable, configure, attach a catalog, rename, disable and delete a free-size cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const renamed = yield* pinnedName("cluster", "-");

      const app = (props: Partial<StarburstGalaxy.ClusterProps>, attach = false) =>
        Effect.gen(function* () {
          // Deployed in every step, so attaching and detaching never deletes it mid-update.
          const catalog = yield* StarburstGalaxy.PostgresqlCatalog("Catalog", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "app",
            username: "galaxy",
            password: secret("cluster-catalog"),
            validate: false,
          });
          const cluster = yield* StarburstGalaxy.Cluster("Cluster", {
            cloudRegionId: REGION,
            autoSuspend: "1 minute",
            catalogs: attach ? [catalog.catalogId] : [],
            ...props,
          });
          return { catalog, cluster };
        });

      // Galaxy creates clusters disabled; `enabled: false` keeps it that way.
      const disabled = yield* stack.deploy(app({ enabled: false }));
      const clusterId = disabled.cluster.clusterId;
      expect(disabled.cluster.enabled).toBe(false);
      expect(disabled.cluster.state._tag).toBe("NotEnabled");
      const created = yield* getCluster(clusterId);
      // Galaxy reports no `enabled` field; a disabled cluster is in state DISABLED.
      expect(created.clusterState).toBe("DISABLED");
      expect(created.cloudRegionId).toBe(REGION);
      expect(created.idleStopMinutes).toBe(1);
      expect(created.minWorkers).toBe(1);
      expect(created.maxWorkers).toBe(1);
      expect(created.resultCacheEnabled).toBe(false);

      // Enabling returns once Galaxy reports it, never waiting for a cold start.
      const enabled = yield* stack.deploy(app({}));
      expect(enabled.cluster.clusterId).toBe(clusterId);
      expect(enabled.cluster.enabled).toBe(true);
      expect(enabled.cluster.state._tag).not.toBe("NotEnabled");
      expect(new URL(enabled.cluster.trinoUri ?? "").protocol).toBe("https:");
      const live = yield* getCluster(clusterId);
      expect(live.clusterState).not.toBe("DISABLED");

      // Configuration converges in place.
      const configured = yield* stack.deploy(app({ autoSuspend: "5 minutes" }));
      expect(configured.cluster.clusterId).toBe(clusterId);
      expect(configured.cluster.idleStopMinutes).toBe(5);
      const reconfigured = yield* getCluster(clusterId);
      expect(reconfigured.idleStopMinutes).toBe(5);

      // The result cache turns on with a visibility, and off again (which clears it).
      const cached = yield* stack.deploy(
        app({ autoSuspend: "5 minutes", resultCache: { visibilitySeconds: 3600 } }),
      );
      expect(cached.cluster.resultCacheEnabled).toBe(true);
      const cachedLive = yield* getCluster(clusterId);
      expect(cachedLive.resultCacheEnabled).toBe(true);
      expect(cachedLive.resultCacheDefaultVisibilitySeconds).toBe(3600);
      const uncached = yield* stack.deploy(app({ autoSuspend: "5 minutes" }));
      expect(uncached.cluster.resultCacheEnabled).toBe(false);
      const uncachedLive = yield* getCluster(clusterId);
      expect(uncachedLive.resultCacheEnabled).toBe(false);
      expect(uncachedLive.resultCacheDefaultVisibilitySeconds).toBeUndefined();

      // A catalog attaches by id, and detaches again.
      const attached = yield* stack.deploy(app({ autoSuspend: "5 minutes" }, true));
      const withCatalog = yield* getCluster(clusterId);
      expect(withCatalog.catalogRefs).toEqual([attached.catalog.catalogId]);
      yield* stack.deploy(app({ autoSuspend: "5 minutes" }));
      const withoutCatalog = yield* getCluster(clusterId);
      expect(withoutCatalog.catalogRefs).toEqual([]);

      // Nuke's `list` reports a cluster under its generated name.
      const provider = yield* Provider.findProvider(StarburstGalaxy.Cluster);
      const generated = (yield* provider.list()).find((cluster) => cluster.clusterId === clusterId);
      expect(generated?.cloudRegionId).toBe(REGION);

      // A rename updates the same cluster.
      const named = yield* stack.deploy(app({ name: renamed, autoSuspend: "5 minutes" }));
      expect(named.cluster.clusterId).toBe(clusterId);
      const renamedLive = yield* getCluster(clusterId);
      expect(renamedLive.name).toBe(renamed);

      // `lookup` finds it by its explicit name; `list` leaves hand-named clusters to their owners.
      yield* expectFound(StarburstGalaxy.Cluster.lookup({ name: renamed }), named.cluster);
      const listed = yield* provider.list();
      expect(listed.some((cluster) => cluster.clusterId === clusterId)).toBe(false);

      // Disabling waits until Galaxy reports it.
      const stopped = yield* stack.deploy(app({ name: renamed, enabled: false }));
      expect(stopped.cluster.enabled).toBe(false);
      const stoppedLive = yield* getCluster(clusterId);
      expect(stoppedLive.clusterState).toBe("DISABLED");

      yield* stack.destroy();
      yield* expectGone(clusterExists(clusterId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:cluster", "live"],
    timeout: 300_000,
  },
);
