/**
 * A cron on Rivet: a Durable Object that runs a job on a RivetKit schedule.
 *
 * Unlike {@link DurableObjectState.cron}, which attaches recurring jobs to any
 * Durable Object, {@link Cron} is a dedicated class whose only work is the
 * job. It stores a RivetKit cron on each wake and exposes `arm` so a caller
 * can create the actor once after deploy.
 *
 * For one-shot or fixed-interval work on an existing Durable Object, use
 * `state.schedule` and `state.cron` directly.
 *
 * @see https://rivet.dev/docs/actors/schedules
 */
import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import type { PlatformIdentity, PlatformServices } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as ConfigError from "effect/Config";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import {
  DurableObject,
  type DurableObjectNamespace,
  type DurableObjectProps,
  type DurableObjectServices,
} from "./DurableObject.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { Providers } from "./Providers.ts";

/** The RPC method RivetKit invokes on each cron tick. */
export const CRON_RUN_ACTION = "run";

export interface CronProps extends DurableObjectProps {
  /**
   * The schedule, as a five- or six-field cron expression:
   * `"0 3 * * *"`, `"*\/10 * * * * *"`.
   */
  cron: string;
  /** The time zone the expression is read in. @default the actor's locale / UTC */
  timeZone?: string;
  /** Defaults to 100. Set to 0 to disable and clear history. Maximum 1,000. */
  maxHistory?: number;
}

export interface CronShape {
  /**
   * Create this actor if it does not exist and ensure its cron is stored.
   * Call once after deploy (from any runtime) so RivetKit can fire later
   * ticks; the instance constructor also refreshes the cron on every wake.
   */
  arm: () => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
  /** The job RivetKit runs on each tick. */
  run: () => Effect.Effect<void, unknown, RuntimeContext | DurableObjectState | Scope>;
}

type CronJob = Effect.Effect<void, unknown, RuntimeContext | DurableObjectState | Scope>;

const doProps = (props: CronProps): InputProps<DurableObjectProps> => ({
  main: props.main,
  ...(props.handler === undefined ? {} : { handler: props.handler }),
});

const wrap =
  (props: CronProps) =>
  <InitReq>(
    impl: Effect.Effect<CronJob, ConfigError.ConfigError, InitReq>,
  ): Effect.Effect<
    Effect.Effect<CronShape, never, RuntimeContext | DurableObjectState | Scope>,
    ConfigError.ConfigError,
    InitReq
  > =>
    Effect.gen(function* () {
      const job = yield* impl;
      return Effect.gen(function* () {
        const state = yield* DurableObjectState;
        yield* state.cron.set({
          name: "job",
          expression: props.cron,
          action: CRON_RUN_ACTION,
          ...(props.timeZone === undefined ? {} : { timezone: props.timeZone }),
          ...(props.maxHistory === undefined ? {} : { maxHistory: props.maxHistory }),
        });
        return {
          arm: () => Effect.void,
          run: () => job,
        };
      });
    });

type CronServices = DurableObjectServices;

export type CronInline<Name extends string, Req> = Effect.Effect<
  DurableObjectNamespace<CronShape>,
  never,
  Req
> &
  Named<Name> &
  PlatformIdentity<Name> & {
    new (_: never): CronShape;
  };

/** The class surface of {@link Cron}. */
export interface CronClass {
  // `Self` names the class (`extends Rivet.Cron<Nightly>()`).
  <_Self>(): {
    /**
     * Declared with its schedule and implementation: an Effect that resolves
     * bindings once per node and returns the job. Provide a pool Layer to
     * `impl` to deploy it; `yield*` the class in the Stack. After deploy,
     * call `getByName(...).arm()` once so the actor exists for RivetKit to
     * schedule.
     */
    <const Name extends string, InitReq = never>(
      name: Name,
      props: InputProps<CronProps>,
      impl: Effect.Effect<CronJob, ConfigError.ConfigError, InitReq>,
    ): CronInline<Name, Providers | Exclude<InitReq, CronServices | PlatformServices>>;
  };
}

/**
 * A **Cron** on Rivet: a Durable Object that runs a job on a RivetKit cron
 * expression. Each tick is a persisted schedule on that actor, so a run due
 * while its node restarts still happens.
 *
 * Declare it by name with its schedule and an Effect that resolves bindings
 * once per node and returns the job. Providing a pool Layer to the
 * implementation is what deploys it. After deploy, call
 * `getByName(name).arm()` once from any runtime to create the actor; later
 * wakes refresh the expression from the instance constructor.
 *
 * For schedules on an actor that already has other RPC methods, use
 * `state.schedule` and `state.cron` on `Rivet.DurableObjectState` instead.
 *
 * ### Declaring a cron
 * **Example:** A nightly job
 * ```typescript
 * export default class Nightly extends Rivet.Cron<Nightly>()(
 *   "Nightly",
 *   { main: import.meta.url, cron: "0 3 * * *" },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.gen(function* () {
 *       const counter = yield* counters.getByName("nightly");
 *       yield* counter.increment();
 *     }).pipe(Effect.orDie);
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 *
 * // After deploy, once:
 * yield* Nightly.getByName("nightly").arm();
 * ```
 *
 * @resource
 */
export const Cron: CronClass = (() =>
  <_Self>() =>
  (name: string, props: InputProps<CronProps>, impl: unknown) => {
    const cronProps = props as CronProps;
    const declare = DurableObject as unknown as () => (
      id: string,
      doProps: InputProps<DurableObjectProps>,
      doImpl: unknown,
    ) => unknown;
    return declare()(
      name,
      doProps(cronProps),
      wrap(cronProps)(impl as Effect.Effect<CronJob, ConfigError.ConfigError, never>),
    );
  }) as unknown as CronClass;
