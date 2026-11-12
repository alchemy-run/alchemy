import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { SqlJob as SqlJobShape } from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  changedFields,
  findFirst,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
  SQL_JOB_NAME,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface SqlJobProps {
  /**
   * Job name. Renaming updates the job in place.
   * @default generated from the stack, logical id and stage (lowercase, `-`-delimited)
   */
  readonly name?: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /**
   * ID of the role the statements run as (a `Role`'s `roleId`). Galaxy
   * checks the role holds `UseCluster` on the cluster when the job is
   * created, so pass the role through that `RolePrivilege` (its `roleId`)
   * to order the grant first.
   */
  readonly role: string;
  /**
   * ID of the cluster the statements run on (a `Cluster`'s `clusterId`).
   * Galaxy refuses a job on a disabled cluster; a suspended one is fine.
   */
  readonly cluster: string;
  /**
   * When the job runs, as a cron expression, e.g. `"0 3 * * *"` for 03:00 daily.
   */
  readonly schedule: string;
  /**
   * IANA time zone `schedule` is evaluated in.
   * @default "UTC"
   */
  readonly timezone?: string;
  /** SQL statements run in order on each execution. */
  readonly queries: ReadonlyArray<string>;
}

export interface SqlJobAttributes {
  /** Galaxy's SQL job ID. */
  readonly sqlJobId: string;
  /** Job name. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** ID of the role the statements run as. */
  readonly roleId: string;
  /** ID of the cluster the statements run on. */
  readonly clusterId: string;
  /** Cron expression. */
  readonly schedule: string;
  /** Time zone of the schedule. */
  readonly timezone: string;
  /** SQL statements, in order. */
  readonly queries: ReadonlyArray<string>;
  /** When Galaxy next runs the job. */
  readonly nextExecution: string;
}

export type SqlJob = Resource<
  "StarburstGalaxy.SqlJob",
  SqlJobProps,
  SqlJobAttributes,
  never,
  Providers
>;

/**
 * A Starburst Galaxy SQL job: SQL statements Galaxy runs on a cluster, as a
 * role, on a cron schedule (scheduled `INSERT INTO … SELECT`, table
 * maintenance, materializations). A run starts the cluster if it is
 * suspended, which Galaxy bills.
 *
 * Every prop updates in place, the name included. SQL jobs have no labels
 * or tags in Galaxy: a job Alchemy created is recognized by its generated
 * name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-engineering/sql-jobs.html
 *
 * ### Scheduling SQL
 * **Example:** Refresh a summary table nightly
 * ```typescript
 * const cluster = yield* StarburstGalaxy.Cluster("Etl", { cloudRegionId: "aws-us-east1" });
 * const etl = yield* StarburstGalaxy.Role("Etl", {});
 * const useCluster = yield* StarburstGalaxy.RolePrivilege("EtlUseCluster", {
 *   role: etl.roleId,
 *   privilege: "UseCluster",
 *   entity: { kind: "Cluster", clusterId: cluster.clusterId },
 * });
 * yield* StarburstGalaxy.SqlJob("NightlyRollup", {
 *   role: useCluster.roleId, // created after the grant Galaxy checks
 *   cluster: cluster.clusterId,
 *   schedule: "0 3 * * *",
 *   timezone: "Europe/Berlin",
 *   queries: [
 *     "DELETE FROM lake.reporting.daily_orders WHERE day = current_date - INTERVAL '1' DAY",
 *     "INSERT INTO lake.reporting.daily_orders SELECT current_date - INTERVAL '1' DAY, count(*) FROM shop.public.orders",
 *   ],
 * });
 * ```
 *
 * @resource
 * @product SQL jobs
 */
export const SqlJob = Resource<SqlJob>("StarburstGalaxy.SqlJob");

/** Galaxy accepted a SQL job create but the job could not be read back. */
export class SqlJobNotResolved extends Data.TaggedError("StarburstGalaxy.SqlJobNotResolved")<{
  readonly jobName: string;
}> {
  override get message() {
    return `SQL job ${this.jobName} could not be found after it was created`;
  }
}

const toAttributes = (job: SqlJobShape): SqlJobAttributes => ({
  sqlJobId: job.sqlJobId,
  name: job.name,
  description: job.description,
  roleId: job.roleId,
  clusterId: job.clusterId,
  schedule: job.cronExpression,
  timezone: job.timezone,
  queries: job.queries,
  nextExecution: job.nextExecution,
});

const getJob = (sqlJobId: string) =>
  galaxy.sqlJobs.getSqlJob({ sqlJobId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Jobs are listed without their cluster and queries: find by name, then read in full. */
const findByName = Effect.fn(function* (name: string) {
  const listed = yield* findFirst(galaxy.sqlJobs.listSqlJobs.items({}), (job) => job.name === name);
  return listed === undefined ? undefined : yield* getJob(listed.sqlJobId);
});

const observe = Effect.fn(function* (sqlJobId: string | undefined, name: string) {
  if (sqlJobId !== undefined) {
    const byId = yield* getJob(sqlJobId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const SqlJobProvider = () =>
  Provider.succeed(SqlJob, {
    stables: ["sqlJobId"],

    nuke: {
      // A job runs on a cluster as a role; delete jobs before both.
      dependsOn: ["StarburstGalaxy.Cluster", "StarburstGalaxy.Role"],
    },

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, SQL_JOB_NAME));
      const job = yield* observe(output?.sqlJobId, name);
      if (job === undefined) return undefined;
      return ownership(toAttributes(job), {
        output,
        explicitName: olds?.name,
        previous,
        key: "sqlJobId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, SQL_JOB_NAME);
      const desired = {
        name,
        description: news.description ?? "",
        roleId: news.role,
        clusterId: news.cluster,
        cronExpression: news.schedule,
        timezone: news.timezone ?? "UTC",
        queries: [...news.queries],
      };

      // Observe
      let job = yield* observe(output?.sqlJobId, name);

      // Ensure
      if (job === undefined) {
        yield* session.note(`Creating SQL job ${name}...`);
        const created = yield* galaxy.sqlJobs
          .createSqlJob(desired)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        job = created ?? (yield* findByName(name));
      }
      if (job === undefined) {
        return yield* new SqlJobNotResolved({ jobName: name });
      }

      // Sync: a PUT that carries the observed `syncToken` and every query.
      // `Conflict` means the job changed since it was read: read it again once.
      const update = Effect.fn(function* (current: SqlJobShape) {
        const delta = changedFields(
          { ...current, description: current.description ?? "" },
          desired,
        );
        if (!hasChanges(delta)) return current;
        yield* session.note(`Updating SQL job ${name}...`);
        return yield* galaxy.sqlJobs.updateSqlJob({
          ...delta,
          sqlJobId: current.sqlJobId,
          queries: desired.queries,
          syncToken: current.syncToken,
        });
      });
      const observed = job;
      job = yield* update(observed).pipe(
        Effect.catchTag("Conflict", () =>
          getJob(observed.sqlJobId).pipe(Effect.flatMap((fresh) => update(fresh ?? observed))),
        ),
      );

      return toAttributes(job);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.sqlJobs
        .deleteSqlJob({ sqlJobId: output.sqlJobId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Listed jobs lack their cluster and queries: read each in full.
    list: () =>
      galaxy.sqlJobs.listSqlJobs.items({}).pipe(
        Stream.filter((listed) => isGeneratedName(listed.name)),
        Stream.mapEffect((listed) => getJob(listed.sqlJobId)),
        Stream.filter((job): job is SqlJobShape => job !== undefined),
        Stream.map(toAttributes),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
  });
