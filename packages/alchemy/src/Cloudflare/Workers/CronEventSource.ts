import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * Subscribe to Cloudflare Cron Triggers with an Effect handler.
 *
 * A single call wires both pieces of a scheduled Worker:
 *
 * - **Deploy-time**: attaches the cron expression to the host Worker's
 *   Cron Triggers.
 * - **Runtime**: registers a `scheduled` listener that runs your Effect on
 *   each fire. The handler receives Cloudflare's `ScheduledController` —
 *   `controller.scheduledTime` is the fire time and `controller.cron` is
 *   the expression that fired.
 *
 * Requires `CronEventSourceLive` provided on the Worker's Effect.
 * A failing handler won't crash the Worker — the event source catches the
 * failure and moves on; log or report errors inside the handler if you
 * need visibility into failed runs.
 *
 * Async (non-Effect) Workers don't use `cron` — they attach schedules with
 * the Worker's `crons` prop and export their own `scheduled` handler from
 * the entry module (see the Async Worker section below). Pass `crons: []`
 * to remove all Cron Triggers from a Worker.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Effect-native Worker (recommended)
 * @example Run an Effect on a schedule
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.Workers.cron("0 12 * * *", (controller) =>
 *       Effect.log(`scheduled at ${controller.scheduledTime}`),
 *     );
 *
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
 * );
 * ```
 *
 * @example Multiple schedules
 * ```typescript
 * // Each handler only runs for fires of its own expression — the listener
 * // checks controller.cron, so a midnight fire never runs the hourly handler.
 * yield* Cloudflare.Workers.cron("0 * * * *", () => syncFeeds);
 * yield* Cloudflare.Workers.cron("0 0 * * *", () => purgeExpired);
 * ```
 *
 * @example Record each fire on a Durable Object
 * ```typescript
 * export default class Worker extends Cloudflare.Worker<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* CronCounter;
 *
 *     yield* Cloudflare.Workers.cron("0 * * * *", (controller) =>
 *       counters.getByName("default").record(controller.scheduledTime),
 *     );
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { times } = yield* counters.getByName("default").snapshot();
 *         return yield* HttpServerResponse.json({ times });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
 * ) {}
 * ```
 *
 * @section Async Worker
 * @example Attach schedules with the `crons` prop and export `scheduled`
 * ```typescript
 * // alchemy.run.ts — attach the cron expressions at deploy time
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   crons: ["0 12 * * *"],
 * });
 *
 * // src/worker.ts — the entry module handles the fires itself
 * export default {
 *   async scheduled(controller: ScheduledController) {
 *     console.log(`scheduled at ${controller.scheduledTime}`);
 *   },
 * };
 * ```
 *
 * @example Dispatch multiple schedules on `controller.cron`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   crons: ["0 * * * *", "0 0 * * *"],
 * });
 *
 * // src/worker.ts — one scheduled handler receives every fire
 * export default {
 *   async scheduled(controller: ScheduledController) {
 *     switch (controller.cron) {
 *       case "0 * * * *":
 *         await syncFeeds();
 *         break;
 *       case "0 0 * * *":
 *         await purgeExpired();
 *         break;
 *     }
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/workers/configuration/cron-triggers/
 */
export const cron = <Req = never>(
  expression: string,
  process: (
    controller: cf.ScheduledController,
  ) => Effect.Effect<void, unknown, Req>,
) => CronEventSource.use((source) => source(expression, process));

export type CronEventSourceService = <Req = never>(
  expression: string,
  process: (
    controller: cf.ScheduledController,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, never>;

export class CronEventSource extends Context.Service<
  CronEventSource,
  CronEventSourceService
>()("Cloudflare.Workers.CronEventSource") {}

export const CronEventSourceLive = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <Req>(
      expression: string,
      process: (
        controller: cf.ScheduledController,
      ) => Effect.Effect<void, unknown, Req>,
    ) {
      // Deploy-time: attach the cron expression to the host Worker. Skipped once
      // running inside the deployed Worker (the global guard), where the only
      // work is registering the runtime scheduled handler below. Namespaced
      // under the host so logical identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind(`Cron(${expression})`, {
            crons: [expression],
          }),
        );
      }

      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "scheduled") return;

        const controller = event.input as cf.ScheduledController;
        if (controller.cron !== expression) return;

        return process(controller).pipe(Effect.catchCause(() => Effect.void));
      });
    }) as CronEventSourceService;
  }),
);
