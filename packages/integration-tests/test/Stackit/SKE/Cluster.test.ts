import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLUSTER_TEST_TIMEOUT, expectClusterGone, slow, smallPool } from "./cluster.ts";

const { test } = makeStackitTest();

// `blocked: cost`. One cluster for about three started hours is EUR 0.48, and the
// rename test runs two: about EUR 1.44 per run. Gated behind STACKIT_TEST_SLOW.
const options = { tags: stackitTags("ske", "cluster"), timeout: CLUSTER_TEST_TIMEOUT } as const;

/** A second project this profile can create clusters in. */
const otherProject = process.env.STACKIT_TEST_OTHER_PROJECT;

test.provider.skipIf(slow)(
  "create, update in place and delete a cluster",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props: Stackit.SKE.ClusterProps = {
        nodepools: [smallPool],
        labels: { env: "test", keep: "yes" },
        maintenance: {
          autoUpdate: { kubernetesVersion: false, machineImageVersion: false },
          timeWindow: { start: "02:00:00Z", end: "04:00:00Z" },
        },
      };
      const created = yield* stack.deploy(Stackit.SKE.Cluster("BasicCluster", props));
      const { clusterName } = created;

      // A generated name fits the API's 11 characters and pattern.
      expect(clusterName).toMatch(/^[a-z0-9]([a-z0-9-]{0,9}[a-z0-9])?$/);
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.state).toEqual("STATE_HEALTHY");
      expect(created.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.connection.auth).toEqual({
        kind: "stackit-ske",
        clusterName,
        projectId,
        region,
      });
      // No credentials in what state keeps.
      expect(JSON.stringify(created.connection)).not.toMatch(/token|certificate|BEGIN/i);

      // Out of band: the requested shape, and Alchemy's ownership labels.
      const fetched = yield* ske.getCluster({ projectId, region, clusterName });
      expect(fetched.kubernetes.version).toEqual(created.kubernetesVersion);
      expect(fetched.labels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "BasicCluster",
      });
      const pool = fetched.nodepools.find((candidate) => candidate.name === "workers");
      expect(pool?.machine.type).toEqual("c1.2");
      expect(pool?.minimum).toEqual(1);
      expect(pool?.volume.size).toEqual(20);
      expect(pool?.allowSystemComponents).toEqual(true);
      expect(fetched.maintenance?.autoUpdate?.kubernetesVersion).toEqual(false);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.SKE.Cluster("BasicCluster", props));
      expect(plan.resources.BasicCluster).toMatchObject({ action: "noop" });

      // Scale the pool's maximum and change labels in place. The minimum holds,
      // so the node (and its bill) stays as it is.
      const updated = yield* stack.deploy(
        Stackit.SKE.Cluster("BasicCluster", {
          ...props,
          nodepools: [{ ...smallPool, maximum: 2 }],
          labels: { env: "prod" },
        }),
      );
      expect(updated.clusterName).toEqual(clusterName);
      expect(updated.labels).toEqual({ env: "prod" });

      const refetched = yield* ske.getCluster({ projectId, region, clusterName });
      expect(
        refetched.nodepools.find((candidate) => candidate.name === "workers")?.maximum,
      ).toEqual(2);
      // The removed `keep` label is gone; ownership labels survive.
      expect(refetched.labels).toMatchObject({ env: "prod", "alchemy.id": "BasicCluster" });
      expect(refetched.labels?.keep).toBeUndefined();
      // Settings the update didn't name are as they were.
      expect(refetched.maintenance?.autoUpdate?.machineImageVersion).toEqual(false);
      expect(refetched.kubernetes.version).toEqual(fetched.kubernetes.version);

      // `list` finds it for nuke.
      const { items } = yield* ske.listClusters({ projectId, region });
      expect(items?.map((item) => item.name)).toContain(clusterName);

      yield* stack.destroy();
      yield* expectClusterGone(projectId, region, clusterName);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "renaming a cluster replaces it and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.SKE.Cluster("RenamedCluster", { name: "alcske1", nodepools: [smallPool] }),
      );
      expect(first.clusterName).toEqual("alcske1");

      const second = yield* stack.deploy(
        Stackit.SKE.Cluster("RenamedCluster", { name: "alcske2", nodepools: [smallPool] }),
      );
      expect(second.clusterName).toEqual("alcske2");
      expect(second.state).toEqual("STATE_HEALTHY");

      yield* expectClusterGone(projectId, region, "alcske1");
      const fetched = yield* ske.getCluster({ projectId, region, clusterName: "alcske2" });
      expect(fetched.status?.aggregated).toEqual("STATE_HEALTHY");

      yield* stack.destroy();
      yield* expectClusterGone(projectId, region, "alcske2");
    }).pipe(logLevel),
  options,
);

// About EUR 0.96 on top of the slow gate: two clusters for about three hours each.
test.provider.skipIf(slow || !otherProject)(
  "moving an explicit-name cluster to a project where that name is taken is refused",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const clusterName = "alcske3";
      // Another logical id stands in for someone else: its labels aren't this resource's.
      const clusters = (project: string) =>
        Effect.gen(function* () {
          const foreign = yield* Stackit.SKE.Cluster("ForeignCluster", {
            name: clusterName,
            projectId: otherProject,
            nodepools: [smallPool],
          });
          const moved = yield* Stackit.SKE.Cluster("MovedCluster", {
            name: clusterName,
            projectId: project,
            nodepools: [smallPool],
          });
          return { foreign, moved };
        });

      yield* stack.deploy(clusters(projectId));

      const error = yield* stack.deploy(clusters(otherProject!)).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The other cluster still holds its own labels: nothing was written over it.
      const fetched = yield* ske.getCluster({
        projectId: otherProject!,
        region,
        clusterName,
      });
      expect(fetched.labels).toMatchObject({ "alchemy.id": "ForeignCluster" });

      yield* stack.destroy();
      yield* expectClusterGone(projectId, region, clusterName);
      yield* expectClusterGone(otherProject!, region, clusterName);
    }).pipe(logLevel),
  options,
);
