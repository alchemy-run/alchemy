import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WarmObject } from "./object.ts";

/**
 * Drives the warm scenarios over HTTP. Each request targets a named DO
 * instance (`?name=`) so tests can isolate instances:
 *  - `GET /ping`    → RPC ping (starts/restarts the container, returns "pong")
 *  - `GET /boot`    → the container process's boot id
 *  - `GET /running` → `{ running }` (never restarts the container)
 *  - `GET /stop`    → destroy the container (SIGKILL)
 *  - `GET /warmed`  → `{ count, runningAtWarm }` as observed by that DO
 *  - `GET /warm`    → run one `warmPool` pass over `?names=a,b`
 *
 * `/warm` calls `warmPool` straight from the fetch handler rather than from a
 * Cron Trigger (the cadence a real caller would use): the fan-out under test
 * is one pass, and driving it directly keeps the test deterministic instead
 * of waiting on cron's once-a-minute floor.
 */
export default Cloudflare.Worker(
  "WarmWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* WarmObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";

        if (url.pathname === "/warm") {
          const names = (url.searchParams.get("names") ?? "")
            .split(",")
            .filter((n) => n.length > 0);
          yield* Cloudflare.Containers.warmPool(objects, {
            names,
            concurrency: Number(url.searchParams.get("concurrency") ?? 10),
          });
          return yield* HttpServerResponse.json({ warmed: names });
        }

        const object = objects.getByName(name);

        if (url.pathname === "/ping") {
          return HttpServerResponse.text(yield* object.ping());
        }
        if (url.pathname === "/boot") {
          return yield* HttpServerResponse.json({ boot: yield* object.boot() });
        }
        if (url.pathname === "/running") {
          return yield* HttpServerResponse.json({
            running: yield* object.running(),
          });
        }
        if (url.pathname === "/stop") {
          yield* object.stop();
          return HttpServerResponse.text("stopped");
        }
        if (url.pathname === "/warmed") {
          return yield* HttpServerResponse.json(yield* object.warmed());
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        // Surface failures as 5xx (not a thrown defect) so the test's readiness
        // retry treats a mid-restart blip as retryable rather than fatal.
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(String(cause), { status: 503 }),
          ),
        ),
      ),
    };
  }),
);
