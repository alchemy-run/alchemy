import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { isWorkerEvent } from "../Cloudflare/Workers/WorkerRuntime.ts";
import * as Namespace from "../Namespace.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { FunctionContext } from "../Serverless/Function.ts";
import { Worker } from "./Worker.ts";

/** The native scheduled event. Failed invocations remain visible to Celld. */
export interface ScheduledController {
  /** Original scheduled fire time, in milliseconds since the Unix epoch. */
  readonly scheduledTime: number;
  /** Matching cron expression. */
  readonly cron: string;
  /** Suppress native retries for this invocation. */
  noRetry(): void;
}

/**
 * Register a root Worker's schedule and listener. Application validates root-only
 * scheduling. Handler failures reach Celld; noRetry disables native retries.
 *
 * Celld v0.5.0 cannot safely retire a previous root's persisted cron cell.
 * Once a root has cron triggers, Application refuses changing its script identity
 * or removing all triggers. Keep the same root script and a nonempty schedule;
 * changing expressions within that schedule remains supported. Root replacement
 * or complete schedule removal requires verified native cron retirement support.
 *
 * ### Schedule a Worker
 * **Example:** Record each scheduled fire
 * ```typescript
 * yield* Celld.cron("0 * * * *", (event) => Effect.log(event.scheduledTime));
 * ```
 *
 * @binding
 * @product Celld
 */
export const cron = <R = never>(
  expression: string,
  process: (event: ScheduledController) => Effect.Effect<void, unknown, R>,
): Effect.Effect<
  void,
  never,
  CronEventSource | Exclude<R, RuntimeContext | Scope.Scope>
> => CronEventSource.use((source) => source(expression, process));

export type CronEventSourceService = <R>(
  expression: string,
  process: (event: ScheduledController) => Effect.Effect<void, unknown, R>,
) => Effect.Effect<void, never, Exclude<R, RuntimeContext | Scope.Scope>>;

/** Service registering Celld scheduled listeners. */
export class CronEventSource extends Context.Service<
  CronEventSource,
  CronEventSourceService
>()("Celld.CronEventSource") {}

/** Match a schedule without swallowing failures or noRetry calls. @internal */
export const processScheduledEvent = <R>(
  expression: string,
  event: ScheduledController,
  process: (event: ScheduledController) => Effect.Effect<void, unknown, R>,
) =>
  event.cron === expression
    ? Effect.suspend(() => process(event)).pipe(Effect.orDie)
    : Effect.void;

/**
 * Register scheduling metadata during deployment and listeners during init.
 *
 * ### Enable cron registration
 * **Example:** Provide the cron event source
 * ```typescript
 * implementation.pipe(Effect.provide(Celld.CronEventSourceLive));
 * ```
 *
 * @layer
 * @provides Celld.CronEventSource
 * @product Celld
 */
export const CronEventSourceLive = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <R>(
      expression: string,
      process: (event: ScheduledController) => Effect.Effect<void, unknown, R>,
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind(`Cron(${expression})`, { crons: [expression] }),
        );
      }
      const context = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* context.listen<void, R>((event) => {
        if (!isWorkerEvent(event) || event.type !== "scheduled") return;
        return processScheduledEvent(
          expression,
          event.input as ScheduledController,
          process,
        );
      });
    }) as CronEventSourceService;
  }),
);
