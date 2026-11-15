import * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetSqlJobStatus } from "./GetSqlJobStatus.ts";
import type { SqlJob } from "./SqlJob.ts";

/**
 * {@link GetSqlJobStatus} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SqlJob
 * @provides StarburstGalaxy.SqlJob.GetSqlJobStatus
 */
export const GetSqlJobStatusHttp = Layer.succeed(
  GetSqlJobStatus,
  Effect.fn("StarburstGalaxy.SqlJob.GetSqlJobStatus")(function* (job: SqlJob) {
    const galaxy = yield* bindStarburstGalaxy;
    const sqlJobIdOf = yield* job.sqlJobId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const sqlJobId = yield* sqlJobIdOf;
          return yield* sqlJobs.getSqlJobStatus({ sqlJobId });
        }),
      );
  }),
);
