import * as sqlJobs from "@distilled.cloud/starburst-galaxy/sql_jobs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { ListSqlJobHistory } from "./ListSqlJobHistory.ts";
import type { SqlJob } from "./SqlJob.ts";

/**
 * {@link ListSqlJobHistory} over the Galaxy API; works on any host.
 *
 * @layer
 * @product SqlJob
 * @provides StarburstGalaxy.SqlJob.ListSqlJobHistory
 */
export const ListSqlJobHistoryHttp = Layer.succeed(
  ListSqlJobHistory,
  Effect.fn("StarburstGalaxy.SqlJob.ListSqlJobHistory")(function* (job: SqlJob) {
    const galaxy = yield* bindStarburstGalaxy;
    const sqlJobIdOf = yield* job.sqlJobId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const sqlJobId = yield* sqlJobIdOf;
          const page = yield* sqlJobs.listSqlJobHistory({ sqlJobId });
          return page.result ?? [];
        }),
      );
  }),
);
