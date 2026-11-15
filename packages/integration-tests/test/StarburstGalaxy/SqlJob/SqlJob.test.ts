import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const jobExists = (sqlJobId: string) =>
  galaxy.sqlJobs.getSqlJob({ sqlJobId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

// Never fires while the test runs, so the job never wakes the cluster.
const YEARLY = "0 0 1 1 *";

test.provider(
  "schedule SQL on an idle cluster, change its statements and schedule, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (props: Pick<StarburstGalaxy.SqlJob.SqlJobProps, "queries" | "schedule">) =>
        Effect.gen(function* () {
          const cluster = yield* StarburstGalaxy.Cluster.Cluster("Cluster", {
            cloudRegionId: "aws-us-east1",
            autoSuspend: "1 minute",
          });
          const role = yield* StarburstGalaxy.Role.Role("Role", {});
          const useCluster = yield* StarburstGalaxy.Role.RolePrivilege("UseCluster", {
            role: role.roleId,
            privilege: "UseCluster",
            entity: { kind: "Cluster", clusterId: cluster.clusterId },
          });
          const job = yield* StarburstGalaxy.SqlJob.SqlJob("Job", {
            // Through the grant, so the job is created after it: Galaxy checks the
            // role can use the cluster (Forbidden GET_CLUSTER otherwise).
            role: useCluster.roleId,
            cluster: cluster.clusterId,
            ...props,
          });
          return { cluster, role, job };
        });

      const created = yield* stack.deploy(app({ schedule: YEARLY, queries: ["SELECT 1"] }));
      const sqlJobId = created.job.sqlJobId;
      const live = yield* galaxy.sqlJobs.getSqlJob({ sqlJobId });
      expect(live.queries).toEqual(["SELECT 1"]);
      expect(live.cronExpression).toBe(YEARLY);
      expect(live.timezone).toBe("UTC");
      expect(live.clusterId).toBe(created.cluster.clusterId);
      expect(live.roleId).toBe(created.role.roleId);

      // Statements and schedule converge in place (a PUT with the sync token).
      const changed = yield* stack.deploy(
        app({ schedule: "0 0 1 7 *", queries: ["SELECT 1", "SELECT 2"] }),
      );
      expect(changed.job.sqlJobId).toBe(sqlJobId);
      const changedLive = yield* galaxy.sqlJobs.getSqlJob({ sqlJobId });
      expect(changedLive.queries).toEqual(["SELECT 1", "SELECT 2"]);
      expect(changedLive.cronExpression).toBe("0 0 1 7 *");

      yield* stack.destroy();
      yield* expectGone(jobExists(sqlJobId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:sql-jobs", "live"],
    timeout: 600_000,
  },
);
