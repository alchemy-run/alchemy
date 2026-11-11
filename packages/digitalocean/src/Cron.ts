import * as Binding from "alchemy/Binding";
import type { HostRuntimeContext } from "alchemy/Runtime/Process";
import { CurrentRuntimeContext, type RuntimeContext } from "alchemy/RuntimeContext";
import { sha256 } from "alchemy/Util/sha256";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { isAppHost, JOB_ENV, type AppJob } from "./internal/appJobs.ts";

export type CronService = <Req = never>(
  expression: string,
  handler: () => Effect.Effect<void, unknown, Req>,
  options?: { readonly timeZone?: string },
) => Effect.Effect<void, never, Exclude<Req, RuntimeContext | Scope.Scope>>;

export { JOB_ENV };

export class Cron extends Context.Service<Cron, CronService>()("DigitalOcean.Cron") {}

/**
 * Run an Effect on a cron schedule inside a `DigitalOcean.App`.
 *
 * - **Deploy-time**: adds an App Platform `SCHEDULED` job to the host App.
 *   The job runs the App's own image, with its env and bindings, on the
 *   schedule.
 * - **Runtime**: the job's container runs the handler once and exits, so
 *   App Platform records the run as succeeded or failed. The App's web
 *   service never runs the handler.
 *
 * A schedule fires at most once a minute. Requires `CronLive` provided on
 * the App's Effect.
 *
 * ### Declare a schedule
 * **Example:** Clean up every night at 03:00 UTC
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* DigitalOcean.cron("0 3 * * *", () => Effect.log("nightly cleanup"));
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(DigitalOcean.CronLive)),
 * ) {}
 * ```
 *
 * **Example:** A schedule in a time zone
 * ```typescript
 * yield* DigitalOcean.cron("0 9 * * 1-5", () => Effect.log("weekday report"), {
 *   timeZone: "Europe/Berlin",
 * });
 * ```
 *
 * @binding
 * @product App Platform
 */
export const cron = <Req = never>(
  expression: string,
  handler: () => Effect.Effect<void, unknown, Req>,
  options?: { readonly timeZone?: string },
): Effect.Effect<void, never, Cron | Exclude<Req, RuntimeContext | Scope.Scope>> =>
  Cron.use((schedule) => schedule(expression, handler, options));

// Job names are unique in the app: a hash of the schedule keeps them stable.
const jobNameOf = (expression: string, timeZone: string | undefined) =>
  sha256(`${expression}\0${timeZone ?? ""}`).pipe(
    Effect.map((hash) => `cron-${hash.slice(0, 12)}`),
  );

/**
 * The `DigitalOcean.Cron` implementation for `DigitalOcean.App`.
 *
 * @layer
 * @product App Platform
 * @provides DigitalOcean.Cron
 */
export const CronLive = Layer.succeed(
  Cron,
  // The handler's requirements are provided by the App runtime that runs it.
  Effect.fn(function* <Req>(
    expression: string,
    handler: () => Effect.Effect<void, unknown, Req>,
    options?: { readonly timeZone?: string },
  ) {
    const name = yield* jobNameOf(expression, options?.timeZone);
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // A scheduled job is a part of the App's own spec, so it attaches to
      // the App host only.
      const host = yield* Binding.Host;
      if (isAppHost(host)) {
        const job: AppJob = { name, cron: expression, timeZone: options?.timeZone };
        yield* host.bind`Cron(${host}, ${name})`({ jobs: [job] });
      }
      return;
    }
    // Only the job's own container runs the handler, once, then exits.
    const job = yield* Config.String(JOB_ENV).pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    if (job !== name) return;
    const runtime = yield* CurrentRuntimeContext;
    // An App's runtime context runs registered effects next to its server.
    if (runtime === undefined || !("run" in runtime)) return;
    yield* (runtime as HostRuntimeContext).run(
      handler().pipe(
        Effect.tapCause(Effect.logError),
        Effect.exit,
        Effect.flatMap((exit) => Effect.sync(() => process.exit(exit._tag === "Success" ? 0 : 1))),
      ),
    );
  }) as CronService,
);
