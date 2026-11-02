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

export type CronProps = HostedProps;

export interface ClusterCronResource extends HostedResource<CronTypeId> {}

/** When a cron runs: its declaration, like Effect's `ClusterCron.make`. */
export interface CronOptions {
  /**
   * The schedule: a cron expression, with an optional leading seconds
   * field (`"0 3 * * *"`, `"*\/10 * * * * *"`), or a parsed `Cron`.
   */
  readonly cron: string | Cron_.Cron;
  /** The time zone a cron expression is read in. @default UTC */
  readonly timeZone?: string;
  /**
   * Compute each run from the previous run's scheduled time rather than
   * from when it finished.
   * @default false
   */
  readonly calculateNextRunFromPrevious?: boolean;
  /** Skip a run that is due longer ago than this, as after an outage. */
  readonly skipIfOlderThan?: Duration.Input;
}

/**
 * A cron as a runner runs it: its schedule, the job its Construction phase
 * returned, and the services that phase ran with.
 * @internal
 */
export interface HostedCron {
  readonly kind: "cron";
  readonly name: string;
  readonly cron: Cron_.Cron;
  readonly options: Pick<CronOptions, "calculateNextRunFromPrevious" | "skipIfOlderThan">;
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

/** Every declared cron's schedule, parsed, by name. */
const schedules = new Map<
  string,
  { readonly options: CronOptions; readonly cron: Result.Result<Cron_.Cron, Cron_.CronParseError> }
>();

const { platform, provider, declare } = makeHostedPlatform(
  CronTypeId,
  (id, run, context): HostedCron => {
    const { options, cron } = schedules.get(id)!;
    return {
      kind: "cron",
      name: id,
      // Checked while deploying, so it parsed.
      cron: (cron as Result.Success<Cron_.Cron, never>).success,
      options: {
        calculateNextRunFromPrevious: options.calculateNextRunFromPrevious,
        skipIfOlderThan: options.skipIfOlderThan,
      },
      run: run as HostedCron["run"],
      context,
    };
  },
  // A schedule that doesn't parse fails the deploy, not the runner.
  (id) => {
    const { cron } = schedules.get(id)!;
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
    /** Its schedule. */
    readonly options: CronOptions;
    /**
     * The cron's implementation, as a Layer: an Effect that resolves
     * bindings once per runner and returns the job to run on schedule.
     * Provide a runners Layer to `impl` to deploy it; provide the returned
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

/** The class surface of {@link Cron}. */
export interface CronClass {
  // `Self` names the class (`extends Cluster.Cron<Nightly>()`).
  <Self>(): <const Name extends string>(name: Name, options: CronOptions) => CronTag<Self, Name>;
}

/**
 * A **Cron** on an Effect Cluster: a job that runs on a schedule, once per
 * scheduled time across the cluster, on whichever runner owns it. Each run
 * is a persisted message, so a run due while its runner restarts still
 * happens.
 *
 * Declare it with its schedule, like Effect's `ClusterCron.make`.
 * `.make(props, impl)` is its implementation, as a Layer: an Effect that
 * resolves bindings once per runner and returns the job. The job can read
 * the time it was scheduled for with `ClusterCron.CurrentScheduledTime`.
 * Providing a runners Layer to the implementation is what deploys it.
 *
 * ### Declaring a cron
 * **Example:** A nightly job
 * ```typescript
 * // src/Nightly.ts
 * export class Nightly extends Cluster.Cron<Nightly>()("Nightly", {
 *   cron: "0 3 * * *",
 *   skipIfOlderThan: "1 hour",
 * }) {}
 *
 * // src/NightlyLive.ts
 * export default Nightly.make(
 *   { main: import.meta.url },
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
export const Cron: CronClass = (() => (name: string, options: CronOptions) => {
  schedules.set(name, {
    options,
    cron:
      typeof options.cron === "string"
        ? Cron_.parse(options.cron, options.timeZone)
        : Result.succeed(options.cron),
  });
  return declare(name, { options });
}) as unknown as CronClass;
