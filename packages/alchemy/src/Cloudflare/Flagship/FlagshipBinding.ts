/// <reference types="@cloudflare/workers-types" />

import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { FlagshipApp } from "./App.ts";
import type { Providers } from "../Providers.ts";

export class FlagshipError extends Data.TaggedError("FlagshipError")<{
  message: string;
  cause: unknown;
}> {}

/** An Effect produced by a {@link FlagshipClient} operation. */
type FlagshipEffect<A> = Effect.Effect<A, FlagshipError, RuntimeContext>;

// Re-exported so callers don't reach into the `@cloudflare/workers-types`
// namespace directly.
export type FlagshipEvaluationContext = cf.FlagshipEvaluationContext;
export type FlagshipEvaluationDetails<T> = cf.FlagshipEvaluationDetails<T>;

/**
 * Effect-native client for a Cloudflare Flagship (feature flags) binding.
 *
 * Mirrors the runtime {@link cf.Flagship} binding one-to-one, translating each
 * promise-returning method into an Effect. Flagship evaluation never throws —
 * it falls back to the provided `defaultValue` — so the {@link FlagshipError}
 * channel only surfaces unexpected runtime failures (e.g. a misconfigured
 * binding). Use `Cloudflare.FlagshipApp.bind(app)` inside a Worker's init
 * phase to obtain it.
 */
export interface FlagshipClient {
  /**
   * Effect resolving to the raw Cloudflare Flagship runtime binding.
   */
  raw: Effect.Effect<cf.Flagship, never, RuntimeContext>;
  /**
   * Get a flag value without type checking. Use when the flag type is not
   * known at compile time.
   */
  get(
    flagKey: string,
    defaultValue?: unknown,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<unknown>;
  /**
   * Get a boolean flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<boolean>;
  /**
   * Get a string flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<string>;
  /**
   * Get a number flag value, falling back to `defaultValue` when evaluation
   * fails or the flag type does not match.
   */
  getNumberValue(
    flagKey: string,
    defaultValue: number,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<number>;
  /**
   * Get a typed object flag value, falling back to `defaultValue` when
   * evaluation fails or the flag type does not match.
   */
  getObjectValue<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<T>;
  /**
   * Get a boolean flag value with full evaluation details (variant, reason,
   * error code).
   */
  getBooleanDetails(
    flagKey: string,
    defaultValue: boolean,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<FlagshipEvaluationDetails<boolean>>;
  /**
   * Get a string flag value with full evaluation details (variant, reason,
   * error code).
   */
  getStringDetails(
    flagKey: string,
    defaultValue: string,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<FlagshipEvaluationDetails<string>>;
  /**
   * Get a number flag value with full evaluation details (variant, reason,
   * error code).
   */
  getNumberDetails(
    flagKey: string,
    defaultValue: number,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<FlagshipEvaluationDetails<number>>;
  /**
   * Get a typed object flag value with full evaluation details (variant,
   * reason, error code).
   */
  getObjectDetails<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: FlagshipEvaluationContext,
  ): FlagshipEffect<FlagshipEvaluationDetails<T>>;
}

/**
 * Binding service that turns a {@link FlagshipApp} resource into a typed
 * {@link FlagshipClient} for Worker runtime code. Prefer the
 * `Cloudflare.FlagshipApp.bind(app)` alias.
 * @binding
 * @product Flagship
 * @category Developer Platform
 */
export class FlagshipBinding extends Binding.Service<
  FlagshipBinding,
  (app: FlagshipApp) => Effect.Effect<FlagshipClient>
>()("Cloudflare.Flagship.Binding") {}

export const FlagshipBindingLive = Layer.effect(
  FlagshipBinding,
  Effect.gen(function* () {
    const Policy = yield* FlagshipBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (app: FlagshipApp) {
      yield* Policy(app);
      const raw: Effect.Effect<cf.Flagship, never, RuntimeContext> =
        Effect.sync(() => (env as Record<string, cf.Flagship>)[app.LogicalId]!);
      return makeFlagshipClient(raw);
    });
  }),
);

export class FlagshipBindingPolicy extends Binding.Policy<
  FlagshipBindingPolicy,
  (app: FlagshipApp) => Effect.Effect<void>,
  Providers
>()("Cloudflare.Flagship.Binding") {}

export const FlagshipBindingPolicyLive = FlagshipBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, app: FlagshipApp) {
    if (isWorker(host)) {
      yield* host.bind(app.LogicalId, {
        bindings: [
          {
            type: "flagship",
            name: app.LogicalId,
            appId: app.appId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`FlagshipBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, FlagshipError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new FlagshipError({
        message:
          error instanceof Error ? error.message : "Unknown Flagship error",
        cause: error,
      }),
  });

/** @internal */
export const makeFlagshipClient = (
  raw: Effect.Effect<cf.Flagship, never, RuntimeContext>,
): FlagshipClient => {
  const call = <T>(
    fn: (binding: cf.Flagship) => Promise<T>,
  ): FlagshipEffect<T> =>
    raw.pipe(Effect.flatMap((binding) => tryPromise(() => fn(binding))));

  return {
    raw,
    get: (flagKey, defaultValue, context) =>
      call((b) => b.get(flagKey, defaultValue, context)),
    getBooleanValue: (flagKey, defaultValue, context) =>
      call((b) => b.getBooleanValue(flagKey, defaultValue, context)),
    getStringValue: (flagKey, defaultValue, context) =>
      call((b) => b.getStringValue(flagKey, defaultValue, context)),
    getNumberValue: (flagKey, defaultValue, context) =>
      call((b) => b.getNumberValue(flagKey, defaultValue, context)),
    getObjectValue: (flagKey, defaultValue, context) =>
      call((b) => b.getObjectValue(flagKey, defaultValue, context)),
    getBooleanDetails: (flagKey, defaultValue, context) =>
      call((b) => b.getBooleanDetails(flagKey, defaultValue, context)),
    getStringDetails: (flagKey, defaultValue, context) =>
      call((b) => b.getStringDetails(flagKey, defaultValue, context)),
    getNumberDetails: (flagKey, defaultValue, context) =>
      call((b) => b.getNumberDetails(flagKey, defaultValue, context)),
    getObjectDetails: (flagKey, defaultValue, context) =>
      call((b) => b.getObjectDetails(flagKey, defaultValue, context)),
  } satisfies FlagshipClient;
};
