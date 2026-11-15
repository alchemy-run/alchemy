import * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { ExecuteSqlJob } from "./ExecuteSqlJob.ts";
import type { SqlJob } from "./SqlJob.ts";

/**
 * {@link ExecuteSqlJob} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SqlJob
 * @provides StarburstGalaxy.SqlJob.ExecuteSqlJob
 */
export const ExecuteSqlJobHttp = Layer.succeed(
  ExecuteSqlJob,
  Effect.fn("StarburstGalaxy.SqlJob.ExecuteSqlJob")(function* (job: SqlJob) {
    const galaxy = yield* bindStarburstGalaxy;
    const sqlJobIdOf = yield* job.sqlJobId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const sqlJobId = yield* sqlJobIdOf;
          yield* sqlJobs.executeSqlJob({ sqlJobId });
        }),
      );
  }),
);
