import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BenchBunObject } from "./bun-object.ts";
import { BenchCrashObject } from "./crashloop-object.ts";
import { BenchEffectfulObject } from "./effectful-object.ts";
import { BenchRemoteObject } from "./remote-object.ts";

/**
 * Benchmark entrypoint. Each request names a fresh DO instance (`?name=`),
 * which boots its own container and reports the cold-start-to-reachable
 * latency measured inside the DO:
 *
 * - `GET /effectful?name=X` → effectful (bundled Effect program) container
 * - `GET /remote?name=X`    → remote (pre-built echo image) container
 * - `GET /bun?name=X`       → bun-baseline (same base image, no Effect bundle)
 * - `GET /crashloop?name=X` → a container that exits immediately (fail-fast)
 *
 * The test fires N distinct names per route concurrently to spin up N
 * containers and compares the variants.
 */
export default class BenchWorker extends Cloudflare.Worker<BenchWorker>()(
  "BenchWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const effectful = yield* BenchEffectfulObject;
    const remote = yield* BenchRemoteObject;
    const bun = yield* BenchBunObject;
    const crash = yield* BenchCrashObject;

    // Cold-start variants exposed on the boot/shutdown lifecycle routes. The
    // crash-loop object is intentionally excluded (it has no steady-state
    // `shutdown` and a different `boot` shape) and keeps its dedicated route.
    const objectFor = (variant: string) =>
      variant === "remote" ? remote : variant === "bun" ? bun : effectful;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";
        const variant = url.searchParams.get("variant") ?? "effectful";

        // Lifecycle routes (the benchmark times boot/shutdown from outside): a
        // distinct `name` is a distinct DO → distinct container, so each /boot
        // is a fresh cold start; /shutdown tears it down so the next boot is
        // independent and the account's container cap isn't exhausted.
        if (url.pathname === "/boot") {
          const result = yield* objectFor(variant).getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }
        if (url.pathname === "/shutdown") {
          yield* objectFor(variant).getByName(name).shutdown();
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Back-compat single-shot routes (boot only).
        if (url.pathname === "/effectful") {
          const result = yield* effectful.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/remote") {
          const result = yield* remote.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/bun") {
          const result = yield* bun.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/crashloop") {
          const result = yield* crash.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(HttpServerResponse.text(String(err), { status: 500 })),
        ),
      ),
    };
  }),
) {}
