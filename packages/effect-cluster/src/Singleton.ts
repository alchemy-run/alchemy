import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import type { PlatformIdentity, PlatformServices } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import type * as ConfigError from "effect/Config";
import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import {
  type HostedProps,
  type HostedResource,
  makeHostedPlatform,
} from "./internal/HostedPlatform.ts";
import type { Providers } from "./Providers.ts";

export const SingletonTypeId = "Cluster.Singleton";
export type SingletonTypeId = typeof SingletonTypeId;

export type SingletonProps = HostedProps;

export interface ClusterSingleton extends HostedResource<SingletonTypeId> {}

/**
 * A singleton as a runner runs it: the fiber its Construction phase
 * returned, and the services that phase ran with.
 * @internal
 */
export interface HostedSingleton {
  readonly kind: "singleton";
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Scope>;
  readonly context: Context.Context<never>;
}

type SingletonServices =
  | ClusterSingleton
  | Providers
  | RuntimeContext
  | Self
  | Self<ClusterSingleton>;

const { platform, provider, declare } = makeHostedPlatform(
  SingletonTypeId,
  (id, run, context): HostedSingleton => ({
    kind: "singleton",
    name: id,
    run: run as HostedSingleton["run"],
    context,
  }),
);

/** The resource type behind every singleton, which the providers register. @internal */
export const SingletonResource = platform;
export const SingletonProvider = provider;

/** A declared singleton, implemented by `.make(props, impl)`. */
export type SingletonTag<Self, Name extends string> = Named<Name> &
  PlatformIdentity<Name> & {
    /**
     * The singleton's implementation, as a Layer: an Effect that resolves
     * bindings once per runner and returns the fiber to run. Provide a
     * pool Layer to `impl` to deploy it; provide the returned Layer to
     * the Stack.
     */
    make<InitReq = never>(
      props: InputProps<SingletonProps>,
      impl: Effect.Effect<Effect.Effect<void, unknown, Scope>, ConfigError.ConfigError, InitReq>,
    ): Layer.Layer<Self, never, Providers | Exclude<InitReq, SingletonServices | PlatformServices>>;
    new (_: never): {};
  };

/** A singleton declared with its implementation: the class is what deploys it. */
export type SingletonInline<Name extends string, Req> = Effect.Effect<
  ClusterSingleton,
  never,
  Req
> &
  Named<Name> &
  PlatformIdentity<Name> & {
    new (_: never): {};
  };

/** The class surface of {@link Singleton}. */
export interface SingletonClass {
  // `Self` names the class (`extends Cluster.Singleton<Reaper>()`).
  <Self>(): {
    /**
     * Declared with its implementation: an Effect that resolves bindings
     * once per runner and returns the fiber. Provide a pool Layer to
     * `impl` to deploy it; `yield*` the class in the Stack.
     */
    <const Name extends string, InitReq = never>(
      name: Name,
      props: InputProps<SingletonProps>,
      impl: Effect.Effect<Effect.Effect<void, unknown, Scope>, ConfigError.ConfigError, InitReq>,
    ): SingletonInline<Name, Providers | Exclude<InitReq, SingletonServices | PlatformServices>>;
    /** A bare declaration, implemented by `.make(props, impl)`. */
    <const Name extends string>(name: Name): SingletonTag<Self, Name>;
  };
}

/**
 * A **Singleton** on an Effect Cluster: one fiber, running on exactly one
 * of its pool. If that runner stops, another starts it.
 *
 * Declare it by name, with its implementation: an Effect that resolves
 * bindings once per runner and returns the fiber, which only the runner
 * that owns the singleton runs. Providing a pool Layer to the
 * implementation is what deploys it. Or declare it bare and implement it
 * with `.make(props, impl)`, as a Layer.
 *
 * ### Declaring a singleton
 * **Example:** A loop that runs once across the cluster
 * ```typescript
 * // src/Reaper.ts
 * export default class Reaper extends Cluster.Singleton<Reaper>()(
 *   "Reaper",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.gen(function* () {
 *       const counter = yield* counters.getByName("reaped");
 *       yield* counter.Increment({ amount: 1 });
 *     }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.orDie);
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * **Example:** Declared bare, and implemented as a Layer
 * ```typescript
 * // src/Reaper.ts
 * export class Reaper extends Cluster.Singleton<Reaper>()("Reaper") {}
 *
 * // src/ReaperLive.ts
 * export default Reaper.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.gen(function* () {
 *       const counter = yield* counters.getByName("reaped");
 *       yield* counter.Increment({ amount: 1 });
 *     }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.orDie);
 *   }).pipe(Effect.provide(Default)),
 * );
 * ```
 *
 * @resource
 */
export const Singleton: SingletonClass = (() =>
  (name: string, props?: InputProps<SingletonProps>, impl?: unknown) =>
    declare(name, {}, props, impl)) as unknown as SingletonClass;
