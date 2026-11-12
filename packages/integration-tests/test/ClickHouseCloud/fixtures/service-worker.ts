import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Analytics, StationsPipe, stationsSource } from "./resources.ts";

export default class ClickHouseServiceWorker extends Cloudflare.Worker<ClickHouseServiceWorker>()(
  "ClickHouseServiceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const getService = yield* ClickHouseCloud.Service.GetService(Analytics);
    const updateState = yield* ClickHouseCloud.Service.UpdateServiceState(Analytics);
    const listBackups = yield* ClickHouseCloud.Backup.ListBackups(Analytics);
    const getBackup = yield* ClickHouseCloud.Backup.GetBackup(Analytics);
    const scrape = yield* ClickHouseCloud.Prometheus.GetServicePrometheusMetrics(Analytics);
    const discover = yield* ClickHouseCloud.ClickPipes.DiscoverClickPipeSchema(Analytics);
    const getPipe = yield* ClickHouseCloud.ClickPipes.GetClickPipe(StationsPipe);
    const updatePipeState = yield* ClickHouseCloud.ClickPipes.UpdateClickPipeState(StationsPipe);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/service") {
          const svc = yield* getService();
          return yield* HttpServerResponse.json({ id: svc.id, state: svc.state });
        }

        if (url.pathname === "/state") {
          const command = url.searchParams.get("command") as "start" | "stop" | "awake";
          const svc = yield* updateState(command);
          return yield* HttpServerResponse.json({ id: svc.id, state: svc.state });
        }

        if (url.pathname === "/backups") {
          const backups = yield* listBackups();
          const first = backups[0];
          const one = first?.id === undefined ? undefined : yield* getBackup(first.id);
          return yield* HttpServerResponse.json({
            count: backups.length,
            serviceIds: backups.map((b) => b.serviceId),
            firstId: first?.id ?? null,
            fetchedId: one?.id ?? null,
          });
        }

        if (url.pathname === "/metrics") {
          return yield* HttpServerResponse.json({ text: yield* scrape({ filteredMetrics: true }) });
        }

        if (url.pathname === "/discover") {
          const schema = yield* discover({ objectStorage: stationsSource });
          return yield* HttpServerResponse.json({
            fields: (schema.fields ?? []).map((f) => ({
              name: f.name,
              type: f.type,
              isVirtual: f.isVirtual === true,
            })),
          });
        }

        if (url.pathname === "/pipe") {
          const pipe = yield* getPipe();
          return yield* HttpServerResponse.json({ id: pipe.id, state: pipe.state });
        }

        if (url.pathname === "/pipe/state") {
          const command = url.searchParams.get("command") as "start" | "stop" | "resync";
          const pipe = yield* updatePipeState(command);
          return yield* HttpServerResponse.json({ id: pipe.id, state: pipe.state });
        }

        // Not 404: a fresh workers.dev URL answers 404 until it propagates.
        return HttpServerResponse.text("no such route", { status: 400 });
      }).pipe(
        // Answer failures and defects with the cause so a failing test shows it.
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClickHouseCloud.Service.GetServiceHttp,
        ClickHouseCloud.Service.UpdateServiceStateHttp,
        ClickHouseCloud.Backup.ListBackupsHttp,
        ClickHouseCloud.Backup.GetBackupHttp,
        ClickHouseCloud.Prometheus.GetServicePrometheusMetricsHttp,
        ClickHouseCloud.ClickPipes.DiscoverClickPipeSchemaHttp,
        ClickHouseCloud.ClickPipes.GetClickPipeHttp,
        ClickHouseCloud.ClickPipes.UpdateClickPipeStateHttp,
      ),
    ),
  ),
) {}
