import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "./resources.ts";

/**
 * `Service.Ping` (`@effect/sql-clickhouse`) on a Worker with `nodejs_compat`.
 * `Query` and `Insert` need a Node.js host: on a Worker the ClickHouse
 * client's result streams end the request with Cloudflare error 1101 (live,
 * 2026-11-12).
 */
export default class ClickHouseSqlWorker extends Cloudflare.Worker<ClickHouseSqlWorker>()(
  "ClickHouseSqlWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const ping = yield* ClickHouseCloud.Service.Ping(Analytics);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: yield* ping() });
        }

        // Not 404: a fresh workers.dev URL answers 404 until it propagates.
        return HttpServerResponse.text("no such route", { status: 400 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(ClickHouseCloud.Service.PingHttp)),
) {}
