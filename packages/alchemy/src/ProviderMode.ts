import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyContext } from "./AlchemyContext.ts";

/**
 * The mode a resource's provider operates in.
 *
 * - `"live"`  — the provider converges real cloud state (deploy).
 * - `"local"` — the provider emulates the resource on the developer's
 *   machine (dev), typically as a long-running process managed by the
 *   dev sidecar.
 *
 * The mode a resource was last reconciled with is persisted on its state
 * row (`providerMode`). Switching a resource between modes is planned as a
 * **replacement**: the new instance is created with the new mode's provider
 * and the old instance is deleted with the provider of the mode that
 * created it.
 */
export type ProviderMode = "live" | "local";

/**
 * ProviderModePolicy pins the provider mode for every resource registered
 * while it is in context, overriding the run-level default derived from
 * `AlchemyContext.dev`.
 *
 * Apply it with the {@link local} / {@link live} combinators — most commonly
 * at the resource or namespace scope:
 *
 * ```ts
 * // Pin one resource to the local provider even during `alchemy deploy`
 * const worker = yield* Worker("Api", { ... }).pipe(local());
 *
 * // Pin everything inside a scope to live providers even during `alchemy dev`
 * yield* Effect.gen(function* () {
 *   const queue = yield* Queue("Jobs", {});
 *   const consumer = yield* Consumer("JobsConsumer", { queue });
 * }).pipe(live());
 * ```
 *
 * The captured mode only takes effect for providers that actually
 * distinguish modes (registered via `ProviderLayer.dual`). Mode-agnostic
 * providers (e.g. an R2 bucket, which is always live) satisfy any requested
 * mode with their single implementation — this is what allows a blanket
 * `local()` over a construct that mixes emulatable and live-only resources.
 */
export class ProviderModePolicy extends Context.Service<
  ProviderModePolicy,
  ProviderMode
>()("ProviderModePolicy") {}

/**
 * The same resource (identified by FQN) was registered (`yield*`ed) from two
 * places whose ambient {@link ProviderModePolicy} disagree — e.g. once inside
 * `local()` and once inside `live()`. Context-based decoration cannot decide
 * which one wins, so the engine fails loudly instead of silently picking one.
 *
 * Fix: register the resource once and close over the returned value, or make
 * both registration sites agree on the mode.
 */
export class ConflictingProviderModeError extends Data.TaggedError(
  "ConflictingProviderModeError",
)<{
  message: string;
  fqn: string;
  /** The mode captured at the first registration site (undefined = default). */
  existingMode: ProviderMode | undefined;
  /** The explicit mode at the conflicting registration site. */
  conflictingMode: ProviderMode;
}> {}

/**
 * Pin resources registered within the wrapped effect to the **local**
 * provider, regardless of whether the run is `alchemy dev` or
 * `alchemy deploy`.
 *
 * `local(false)` pins to live instead; an `Effect<boolean>` may be passed to
 * decide dynamically (mirroring `adopt` / `retain`).
 */
export const local: {
  (
    enabled?: boolean,
  ): <A, E, R = never>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  <R1 = never>(
    enabled: Effect.Effect<boolean, never, R1>,
  ): <A, E, R2 = never>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E, R1 | R2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, any, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(ProviderModePolicy, enabled ? "local" : "live")
        : Effect.provideServiceEffect(
            ProviderModePolicy,
            enabled.pipe(
              Effect.map((a): ProviderMode => (a ? "local" : "live")),
            ),
          ),
    )) as any;

/**
 * Pin resources registered within the wrapped effect to the **live**
 * provider, regardless of whether the run is `alchemy dev` or
 * `alchemy deploy`.
 *
 * `live(false)` pins to local instead; an `Effect<boolean>` may be passed to
 * decide dynamically (mirroring `adopt` / `retain`).
 */
export const live: {
  (
    enabled?: boolean,
  ): <A, E, R = never>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  <R1 = never>(
    enabled: Effect.Effect<boolean, never, R1>,
  ): <A, E, R2 = never>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E, R1 | R2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, any, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(ProviderModePolicy, enabled ? "live" : "local")
        : Effect.provideServiceEffect(
            ProviderModePolicy,
            enabled.pipe(
              Effect.map((a): ProviderMode => (a ? "live" : "local")),
            ),
          ),
    )) as any;

/**
 * Resolve the run-level default provider mode:
 *
 * 1. An ambient {@link ProviderModePolicy} (e.g. `local()` wrapped around a
 *    whole deploy) takes precedence.
 * 2. Otherwise `AlchemyContext.dev` decides: `dev: true` → `"local"`.
 * 3. Without an AlchemyContext (bare engine tests), default to `"live"`.
 */
export const defaultProviderMode: Effect.Effect<ProviderMode> = Effect.gen(
  function* () {
    const fromService = yield* Effect.serviceOption(ProviderModePolicy);
    if (Option.isSome(fromService)) return fromService.value;
    const ctx = yield* Effect.serviceOption(AlchemyContext);
    return Option.match(ctx, {
      onNone: () => "live" as const,
      onSome: (c) => (c.dev ? ("local" as const) : ("live" as const)),
    });
  },
);
