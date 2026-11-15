import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { PruneOrders } from "./bindings.ts";

const { SqlJob } = StarburstGalaxy;

/** A Worker that runs a SQL job and follows its runs through the SqlJob bindings. */
export default class GalaxySqlJobWorker extends Cloudflare.Worker<GalaxySqlJobWorker>()(
  "GalaxySqlJobWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const executeSqlJob = yield* SqlJob.ExecuteSqlJob(PruneOrders);
    const getSqlJobStatus = yield* SqlJob.GetSqlJobStatus(PruneOrders);
    const listSqlJobHistory = yield* SqlJob.ListSqlJobHistory(PruneOrders);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/execute") {
          yield* executeSqlJob();
          return yield* HttpServerResponse.json({ started: true });
        }

        if (url.pathname === "/status") {
          const status = yield* getSqlJobStatus();
          return yield* HttpServerResponse.json({
            sqlJobId: status.sqlJobId,
            status: status.status,
            updatedAt: status.updatedAt,
            errorMessage: status.errorMessage ?? null,
          });
        }

        if (url.pathname === "/history") {
          const runs = yield* listSqlJobHistory();
          return yield* HttpServerResponse.json({
            runs: runs.map((run) => ({ status: run.status, queries: run.queries })),
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlJob.ExecuteSqlJobHttp,
        SqlJob.GetSqlJobStatusHttp,
        SqlJob.ListSqlJobHistoryHttp,
      ),
    ),
  ),
) {}
