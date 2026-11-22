import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  HEARTBEATS,
  REPORTS,
  Runs,
  heartbeatKey,
  reportKey,
  type DailyReport,
  type Heartbeat,
} from "./resources.ts";

/** Most rows `GET /heartbeats` and `GET /reports` return. */
const MAX_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An Azure Function (Flex Consumption) with two timer schedules and two
 * read routes.
 *
 * Each `Azure.Functions.schedule` registers a native `timerTrigger`
 * function. The Functions host fires it on the NCRONTAB schedule (six
 * fields, seconds first, UTC), so no loop runs in the program and one
 * instance runs each occurrence.
 *
 * - every minute — write a heartbeat blob.
 * - daily at 00:00 UTC — count the last 24 hours of heartbeats and write
 *   a report blob.
 * - `GET /heartbeats?limit=N` and `GET /reports?limit=N` — the newest
 *   blobs first.
 */
export default class Monitor extends Azure.Functions.Function<Monitor>()(
  "Monitor",
  { main: import.meta.url },
  Effect.gen(function* () {
    const container = yield* Runs;
    const runs = yield* Azure.Storage.BlobContainerReadWrite(container);

    const write = (key: string, value: Heartbeat | DailyReport) =>
      runs.put(key, JSON.stringify(value), { contentType: "application/json" });

    /** Keys under each prefix, newest first (one page of up to 5000 per prefix). */
    const keysUnder = (prefixes: string[]) =>
      Effect.forEach(prefixes, (prefix) => runs.list({ prefix, maxResults: 5000 })).pipe(
        Effect.map((pages) =>
          pages
            .flatMap((page) => page.blobs.map((blob) => blob.key))
            .sort()
            .reverse(),
        ),
      );

    /** Heartbeat keys for today and yesterday (UTC), newest first. */
    const recentHeartbeatKeys = (now: Date) =>
      keysUnder([
        `${HEARTBEATS}${new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10)}`,
        `${HEARTBEATS}${now.toISOString().slice(0, 10)}`,
      ]);

    const readAll = (keys: string[]) =>
      Effect.forEach(keys, (key) =>
        runs
          .get(key)
          .pipe(Effect.map((blob) => (blob === undefined ? [] : [JSON.parse(blob.text())]))),
      ).pipe(Effect.map((bodies) => bodies.flat()));

    yield* Azure.Functions.schedule("Heartbeat", "0 * * * * *", (run) =>
      Effect.gen(function* () {
        const at = yield* Effect.sync(() => new Date().toISOString());
        yield* write(heartbeatKey(at), { at, isPastDue: run.isPastDue });
        yield* Effect.log(`heartbeat ${at}${run.isPastDue ? " (past due)" : ""}`);
      }).pipe(
        // A failed write fails this occurrence; the next one runs on schedule.
        Effect.orDie,
      ),
    );

    yield* Azure.Functions.schedule("DailyReport", "0 0 0 * * *", () =>
      Effect.gen(function* () {
        const now = yield* Effect.sync(() => new Date());
        const at = now.toISOString();
        const since = heartbeatKey(new Date(now.getTime() - DAY_MS).toISOString());
        const keys = yield* recentHeartbeatKeys(now);
        const heartbeats = keys.filter((key) => key >= since && key <= heartbeatKey(at)).length;
        yield* write(reportKey(at), { at, heartbeats });
        yield* Effect.log(`daily report ${at}: ${heartbeats} heartbeat(s)`);
      }).pipe(Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? 5) || 5, 1),
          MAX_LIMIT,
        );

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }
        if (request.method === "GET" && url.pathname === "/heartbeats") {
          const now = yield* Effect.sync(() => new Date());
          const keys = yield* recentHeartbeatKeys(now).pipe(Effect.orDie);
          const heartbeats = yield* readAll(keys.slice(0, limit)).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ heartbeats });
        }
        if (request.method === "GET" && url.pathname === "/reports") {
          const keys = yield* keysUnder([REPORTS]).pipe(Effect.orDie);
          const reports = yield* readAll(keys.slice(0, limit)).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ reports });
        }
        return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
