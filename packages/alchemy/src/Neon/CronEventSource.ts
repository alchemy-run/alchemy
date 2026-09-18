import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Binding from "../Binding.ts";
import * as Namespace from "../Namespace.ts";
import { ProviderModePolicy } from "../ProviderMode.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { Function } from "./Function.ts";
import { FunctionRequest } from "./FunctionEnvironment.ts";
import { FunctionTrigger } from "./FunctionTrigger.ts";
import {
  decodeFunctionTriggerEvent,
  type CronEvent,
} from "./FunctionTriggerEvent.ts";

export interface CronEventSourceProps {
  /** Numeric five-field UTC cron expression. */ cron: string;
  /** Enable future delivery. @default true */ enabled?: boolean;
}
export type CronEventSourceService = <R = never>(
  name: string,
  props: CronEventSourceProps,
  handler: (event: CronEvent) => Effect.Effect<void, unknown, R>,
) => Effect.Effect<void, never, Exclude<R, RuntimeContext | Scope>>;
/**
 * Register a typed POST route and a separately tracked FunctionTrigger.
 * Handler failures remain non-success HTTP responses. No Neon `scheduled`
 * export or exactly-once guarantee is invented.
 *
 * ### Register a Schedule
 * **Example:** Process a scheduled occurrence
 * ```typescript
 * yield* Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }, event => Effect.log(event.invocationId));
 * ```
 *
 * @binding
 */
export interface CronEventSource extends Binding.Service<
  CronEventSource,
  "Neon.CronEventSource",
  CronEventSourceService
> {
  <R = never>(
    name: string,
    props: CronEventSourceProps,
    handler: (event: CronEvent) => Effect.Effect<void, unknown, R>,
  ): Effect.Effect<
    void,
    never,
    CronEventSource | Exclude<R, RuntimeContext | Scope>
  >;
}
export const CronEventSource = Binding.Service<CronEventSource>(
  "Neon.CronEventSource",
);

/**
 * Neon Function HTTP schedule dispatch and deployment wiring.
 *
 * @layer
 * @provides Neon.CronEventSource
 */
export const CronEventSourceBinding = Layer.effect(
  CronEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    const Trigger = yield* FunctionTrigger;
    return Effect.fn(function* (
      name: string,
      props: CronEventSourceProps,
      handler: (event: CronEvent) => Effect.Effect<void, unknown>,
    ) {
      const path = `/__alchemy/neon/cron/${encodeURIComponent(name)}`;
      const triggerName = `${host.FQN}:${name}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const context = yield* AlchemyContext;
        const remote = yield* ProviderModePolicy;
        if (!context.dev || remote)
          yield* Namespace.push(
            host.LogicalId,
            Trigger(name, {
              function: host,
              type: "schedule",
              name: triggerName,
              schedule: { cron: props.cron },
              path,
              enabled: props.enabled,
            }),
          );
      }
      yield* host.route(
        path,
        Effect.gen(function* () {
          const event = yield* decodeFunctionTriggerEvent(
            yield* FunctionRequest,
          );
          if (
            event.trigger.type !== "schedule" ||
            event.trigger.name !== triggerName ||
            !("scheduled_at" in event.data)
          )
            return HttpServerResponse.empty({ status: 400 });
          yield* handler({
            invocationId: event.invocation_id,
            triggerId: event.trigger.id,
            name,
            scheduledAt: event.data.scheduled_at,
          }).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(
          Effect.catchTag("FunctionTriggerEventError", (error) =>
            Effect.succeed(HttpServerResponse.empty({ status: error.status })),
          ),
        ),
      );
    }) as CronEventSourceService;
  }),
);
