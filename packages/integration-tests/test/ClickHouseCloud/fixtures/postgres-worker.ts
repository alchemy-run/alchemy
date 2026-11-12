import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BindingsDb } from "./resources.ts";

const lastHour = () => ({
  fromDate: new Date(Date.now() - 3_600_000).toISOString(),
  toDate: new Date().toISOString(),
});

export default class ClickHousePostgresWorker extends Cloudflare.Worker<ClickHousePostgresWorker>()(
  "ClickHousePostgresWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* ClickHouseCloud.Postgres.Connect(BindingsDb);
    const getService = yield* ClickHouseCloud.Postgres.GetPostgresService(BindingsDb);
    const updateState = yield* ClickHouseCloud.Postgres.UpdatePostgresServiceState(BindingsDb);
    const metrics = yield* ClickHouseCloud.Postgres.GetPostgresServiceMetrics(BindingsDb);
    const logs = yield* ClickHouseCloud.Postgres.ListPostgresLogs(BindingsDb);
    const slowQueries = yield* ClickHouseCloud.Postgres.ListPostgresSlowQueryPatterns(BindingsDb);
    const slowQuery = yield* ClickHouseCloud.Postgres.GetPostgresSlowQueryPattern(BindingsDb);
    const backups = yield* ClickHouseCloud.Postgres.ListPostgresServiceBackups(BindingsDb);
    const scrape =
      yield* ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetrics(BindingsDb);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/connection") {
          // Test-only: hands the runner the credentials to prove they work.
          const connectionString = yield* db.connectionString;
          return yield* HttpServerResponse.json({
            hostname: (yield* db.hostname) ?? null,
            username: (yield* db.username) ?? null,
            connectionString: connectionString ? Redacted.value(connectionString) : null,
            caCertificates: (yield* db.caCertificates) ?? null,
          });
        }

        if (url.pathname === "/service") {
          const svc = yield* getService();
          return yield* HttpServerResponse.json({ id: svc.id, state: svc.state });
        }

        if (url.pathname === "/state") {
          const svc = yield* updateState("restart");
          return yield* HttpServerResponse.json({ id: svc.id, state: svc.state });
        }

        if (url.pathname === "/metrics") {
          const result = yield* metrics(lastHour());
          return yield* HttpServerResponse.json({ keys: result.metrics.map((m) => m.key) });
        }

        if (url.pathname === "/logs") {
          const entries = yield* logs({ ...lastHour(), limit: 10 });
          return yield* HttpServerResponse.json({ count: entries.length });
        }

        if (url.pathname === "/slow-queries") {
          const patterns = yield* slowQueries({ ...lastHour(), sortBy: "total_duration" });
          const first = patterns.find((p) => p.queryText.includes("pg_sleep"));
          const detail =
            first === undefined
              ? undefined
              : yield* slowQuery({
                  queryId: first.queryId,
                  dbName: first.dbName,
                  dbUser: first.dbUser,
                  dbOperation: first.dbOperation,
                });
          return yield* HttpServerResponse.json({
            queryId: first?.queryId ?? null,
            detailQueryId: detail?.aggregate?.queryId ?? null,
          });
        }

        if (url.pathname === "/backups") {
          const list = yield* backups();
          return yield* HttpServerResponse.json({ statuses: list.map((b) => b.status) });
        }

        if (url.pathname === "/prometheus") {
          return yield* HttpServerResponse.json({ text: yield* scrape() });
        }

        // Not 404: a fresh workers.dev URL answers 404 until it propagates.
        return HttpServerResponse.text("no such route", { status: 400 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClickHouseCloud.Postgres.ConnectHttp,
        ClickHouseCloud.Postgres.GetPostgresServiceHttp,
        ClickHouseCloud.Postgres.UpdatePostgresServiceStateHttp,
        ClickHouseCloud.Postgres.GetPostgresServiceMetricsHttp,
        ClickHouseCloud.Postgres.ListPostgresLogsHttp,
        ClickHouseCloud.Postgres.ListPostgresSlowQueryPatternsHttp,
        ClickHouseCloud.Postgres.GetPostgresSlowQueryPatternHttp,
        ClickHouseCloud.Postgres.ListPostgresServiceBackupsHttp,
        ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetricsHttp,
      ),
    ),
  ),
) {}
