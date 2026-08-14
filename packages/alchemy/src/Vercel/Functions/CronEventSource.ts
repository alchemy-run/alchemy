import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { VercelFunctionContext } from "./FunctionBridge.ts";
import { Function } from "./Function.ts";

/**
 * Cron handler routes are registered under this stable prefix; the bridge
 * dispatches them BEFORE user `fetch`, guarded by `CRON_SECRET`.
 */
export const CRON_PATH_PREFIX = "/_alchemy/cron/";

/**
 * Subscribe a Vercel Function to a cron schedule with an Effect handler.
 *
 * A single call wires both halves of a scheduled Function:
 *
 * - **Deploy-time**: contributes `{ crons: [{ path, schedule }] }` through
 *   the Function's binding contract — the deploy engine lowers it into the
 *   Build Output `config.json`, and the provider auto-mints a sensitive
 *   `CRON_SECRET` project env var (Vercel's cron invoker sends
 *   `Authorization: Bearer $CRON_SECRET` whenever that env var exists).
 * - **Runtime**: registers the handler under a stable internal route
 *   (`/_alchemy/cron/{n}`); the bridge routes it before user `fetch` and
 *   verifies the bearer with a constant-time comparison — an unauthorized
 *   request is a 401 and never reaches the handler.
 *
 * Platform semantics (D3/D8): crons are deployment artifacts, UTC, and fire
 * only on **production** deployments — a preview/tenant stage's crons never
 * run. Hobby plans are limited to daily schedules (a sub-daily schedule
 * fails the deployment, not the plan). A failing handler responds 500 so
 * Vercel records the invocation as failed; express retries declaratively
 * with `Effect.retry` inside the handler.
 *
 * Requires `CronEventSourceLive` provided on the Function's Effect.
 *
 * @binding
 * @product Functions
 *
 * @section Declare a schedule
 * @example Nightly cleanup
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default Vercel.Function(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Vercel.cron("0 3 * * *", Effect.log("nightly cleanup"));
 *
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Vercel.CronEventSourceLive)),
 * );
 * ```
 *
 * @section Multiple schedules
 * @example One handler per expression
 * ```typescript
 * // Each handler gets its own guarded route, so a daily fire never runs
 * // the hourly handler.
 * yield* Vercel.cron("0 * * * *", syncFeeds);
 * yield* Vercel.cron("0 0 * * *", purgeExpired);
 * ```
 *
 * @see https://vercel.com/docs/cron-jobs
 */
export const cron = <Req = never>(
  schedule: string,
  handler: Effect.Effect<void, unknown, Req>,
): Effect.Effect<void, never, CronEventSource | Exclude<Req, RuntimeContext>> =>
  CronEventSource.use((source) => source(schedule, handler));

export type CronEventSourceService = <Req = never>(
  schedule: string,
  handler: Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, Exclude<Req, RuntimeContext>>;

export class CronEventSource extends Context.Service<
  CronEventSource,
  CronEventSourceService
>()("Vercel.Functions.CronEventSource") {}

export const CronEventSourceLive = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    // Registration-order index: the SAME init code runs at plan time and
    // inside the deployed bundle, so the deploy-time path in `config.json`
    // and the runtime route registration always agree.
    let counter = 0;
    return Effect.fn(function* <Req>(
      schedule: string,
      handler: Effect.Effect<void, unknown, Req>,
    ) {
      const sid = counter++;
      const path = `${CRON_PATH_PREFIX}${sid}`;
      // Deploy-time: contribute the cron entry to the host Function's
      // binding channel. Skipped once running inside the deployed bundle
      // (the global guard), where the only work is registering the runtime
      // handler below.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind(`Cron(${sid}:${schedule})`, {
            crons: [{ path, schedule }],
          }),
        );
      }

      const ctx = (yield* RuntimeContext) as unknown as VercelFunctionContext;
      yield* ctx.registerCron(
        path,
        handler as Effect.Effect<void, unknown, any>,
      );
    }) as CronEventSourceService;
  }),
);
