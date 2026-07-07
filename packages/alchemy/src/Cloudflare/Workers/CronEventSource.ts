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
 * This wires both pieces of a scheduled Worker:
 *
 * - **Runtime**: registers a `scheduled` listener on the Worker.
 * - **Deploy-time**: attaches the cron expression to the host Worker.
 * @binding
 * @product Workers
 * @category Workers & Compute
 * @example
 * ```typescript
 * yield* Cloudflare.Workers.cron("0 12 * * *", (controller) =>
 *   Effect.log(`scheduled at ${controller.scheduledTime}`),
 * );
 * ```
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
