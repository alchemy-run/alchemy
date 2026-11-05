import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import type { PlatformIdentity, PlatformServices } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import type { ClusterCron } from "effect/cluster";
import type * as ConfigError from "effect/Config";
import type * as Context from "effect/Context";
import * as Cron_ from "effect/Cron";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type { Scope } from "effect/Scope";
import {
  type HostedProps,
  type HostedResource,
  makeHostedPlatform,
} from "./internal/HostedPlatform.ts";
import type { Providers } from "./Providers.ts";

export const CronTypeId = "Cluster.Cron";
export type CronTypeId = typeof CronTypeId;

/** When a cron runs: its Layer's props, like Effect's `ClusterCron.make` options. */
export interface CronProps extends HostedProps {
  /**
   * The schedule, as a cron expression with an optional leading seconds
   * field: `"0 3 * * *"`, `"*\/10 * * * * *"`.
   */
  cron: string;
  /** The time zone the expression is read in. @default UTC */
  timeZone?: string;
  /**
   * Compute each run from the previous run's scheduled time rather than
   * from when it finished.
   * @default false
   */
  calculateNextRunFromPrevious?: boolean;
  /** Skip a run that is due longer ago than this, as after an outage. */
  skipIfOlderThan?: Duration.Input;
}

export interface ClusterCronResource extends HostedResource<CronTypeId, CronProps> {}

/**
 * A cron as a runner runs it: its schedule, the job its Construction phase
 * returned, and the services that phase ran with.
 * @internal
 */
export interface HostedCron {
  readonly kind: "cron";
  readonly name: string;
  readonly cron: Cron_.Cron;
  readonly options: Pick<CronProps, "calculateNextRunFromPrevious" | "skipIfOlderThan">;
  readonly run: Effect.Effect<void, unknown, Scope | ClusterCron.CurrentScheduledTime>;
  readonly context: Context.Context<never>;
}

/** A cron expression that doesn't parse. */
export class InvalidCron extends Data.TaggedError("Cluster.InvalidCron")<{
  readonly message: string;
}> {}

type CronServices =
  | ClusterCronResource
  | Providers
  | RuntimeContext
  | Self
  | Self<ClusterCronResource>;

const { platform, provider, declare } = makeHostedPlatform<CronTypeId, HostedCron, CronProps>(
  CronTypeId,
  (id, run, context, props) => ({
    kind: "cron",
    name: id,
    // Checked while deploying, so it parses.
    cron: (Cron_.parse(props.cron, props.timeZone) as Result.Success<Cron_.Cron, never>).success,
    options: {
      calculateNextRunFromPrevious: props.calculateNextRunFromPrevious,
      skipIfOlderThan: props.skipIfOlderThan,
    },
    run: run as HostedCron["run"],
    context,
  }),
  // A schedule that doesn't parse fails the deploy, not the runner.
  (id, _context, props) => {
    const cron = Cron_.parse(props.cron, props.timeZone);
    return Result.isSuccess(cron)
      ? Effect.void
      : Effect.die(new InvalidCron({ message: `Cluster.Cron '${id}': ${cron.failure.message}` }));
  },
);

/** The resource type behind every cron, which the providers register. @internal */
export const CronResource = platform;
export const CronProvider = provider;

/** A declared cron, implemented by `.make(props, impl)`. */
export type CronTag<Self, Name extends string> = Named<Name> &
  PlatformIdentity<Name> & {
    /**
     * The cron's implementation, as a Layer: its schedule, and an Effect
     * that resolves bindings once per runner and returns the job to run.
     * Provide a pool Layer to `impl` to deploy it; provide the returned
     * Layer to the Stack.
     */
    make<InitReq = never>(
      props: InputProps<CronProps>,
      impl: Effect.Effect<
        Effect.Effect<void, unknown, Scope | ClusterCron.CurrentScheduledTime>,
        ConfigError.ConfigError,
        InitReq
      >,
    ): Layer.Layer<Self, never, Providers | Exclude<InitReq, CronServices | PlatformServices>>;
    new (_: never): {};
  };

/** A cron declared with its implementation: the class is what deploys it. */
export type CronInline<Name extends string, Req> = Effect.Effect<ClusterCronResource, never, Req> &
  Named<Name> &
  PlatformIdentity<Name> & {
    new (_: never): {};
  };

/** The class surface of {@link Cron}. */
export interface CronClass {
  // `Self` names the class (`extends Cluster.Cron<Nightly>()`).
  <Self>(): {
    /**
     * Declared with its implementation: an Effect that resolves bindings
     * once per runner and returns the job. Provide a pool Layer to
     * `impl` to deploy it; `yield*` the class in the Stack.
     */
    <const Name extends string, InitReq = never>(
      name: Name,
      props: InputProps<CronProps>,
      impl: Effect.Effect<
        Effect.Effect<void, unknown, Scope | ClusterCron.CurrentScheduledTime>,
        ConfigError.ConfigError,
        InitReq
      >,
    ): CronInline<Name, Providers | Exclude<InitReq, CronServices | PlatformServices>>;
    /** A bare declaration, implemented by `.make(props, impl)`. */
    <const Name extends string>(name: Name): CronTag<Self, Name>;
  };
}

/**
 * A **Cron** on an Effect Cluster: a job that runs on a schedule, once per
 * scheduled time across the cluster, on whichever runner owns it. Each run
 * is a persisted message, so a run due while its runner restarts still
 * happens.
 *
 * Declare it by name, with its schedule, as Effect's `ClusterCron.make`
 * takes it, and its implementation: an Effect that resolves bindings once
 * per runner and returns the job. The job can read the time it was
 * scheduled for with `ClusterCron.CurrentScheduledTime`. Providing a pool
 * Layer to the implementation is what deploys it. Or declare it bare and
 * implement it with `.make(props, impl)`, as a Layer.
 *
 * ### Declaring a cron
 * **Example:** A nightly job
 * ```typescript
 * // src/Nightly.ts
 * export default class Nightly extends Cluster.Cron<Nightly>()(
 *   "Nightly",
 *   { main: import.meta.url, cron: "0 3 * * *", skipIfOlderThan: "1 hour" },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.gen(function* () {
 *       const counter = yield* counters.getByName("nightly");
 *       yield* counter.Increment({ amount: 1 });
 *     }).pipe(Effect.orDie);
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * **Example:** Declared bare, and implemented as a Layer
 * ```typescript
 * // src/Nightly.ts
 * export class Nightly extends Cluster.Cron<Nightly>()("Nightly") {}
 *
 * // src/NightlyLive.ts
 * export default Nightly.make(
 *   { main: import.meta.url, cron: "0 3 * * *", skipIfOlderThan: "1 hour" },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.gen(function* () {
 *       const counter = yield* counters.getByName("nightly");
 *       yield* counter.Increment({ amount: 1 });
 *     }).pipe(Effect.orDie);
 *   }).pipe(Effect.provide(Default)),
 * );
 * ```
 *
 * @resource
 */
export const Cron: CronClass = (() =>
  (name: string, props?: InputProps<CronProps>, impl?: unknown) =>
    declare(name, {}, props, impl)) as unknown as CronClass;
