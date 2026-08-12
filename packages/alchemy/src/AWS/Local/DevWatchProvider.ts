/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * INTERNAL — the shared skeleton for `alchemy dev` AWS providers that deploy
 * into the floci emulator and keep a long-lived watch loop hot-swapping the
 * resource on file change ([Lambda FlociFunctionProvider](../Lambda/FlociFunctionProvider.ts),
 * [ECS FlociTaskProvider](../ECS/FlociTaskProvider.ts),
 * [ECS FlociServiceProvider](../ECS/FlociServiceProvider.ts)).
 *
 * What the helper owns (identically for every consumer):
 *
 * - **RPC-sidecar hosting** via {@link RpcProvider.effect} with the shared
 *   AWS dev sidecar entry ([Local.ts](./Local.ts)), so the provider and its
 *   watch fibers survive exec-process hot reloads during `alchemy dev`.
 * - **Live-provider delegation** — builds the caller's LIVE provider layer
 *   inside the floci override context ({@link flociServices} + optional
 *   caller-supplied extra service layers) and wraps every lifecycle method
 *   with {@link withProviderContext}, so the exact same reconcile/read/
 *   delete/list logic runs against the emulator gateway with the dummy
 *   account.
 * - **The instanceId-guarded watch registry** — one watch fiber per logical
 *   id; a config change interrupts and restarts it; a create-first
 *   replacement's old-generation delete cannot kill the successor's watcher.
 * - **The dev diff policy** — the diff NEVER bundles or builds:
 *   resource-specific replacement rules run first (spec `replaceOn`), a
 *   fresh session with state rows but no registered watcher forces an
 *   `update` (converges the emulator and restarts the watcher), and
 *   structurally-equal props (spec `normalizeProps`) are a `noop` because
 *   content-only changes are the watch loop's job.
 * - **Serialized reconciles** — engine reconciles, watcher-triggered
 *   re-reconciles ({@link DevWatchContext.rerunReconcile}), and deletes are
 *   serialized per logical id, so a rebuild-and-swap never interleaves with
 *   an engine-driven converge.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { havePropsChanged, isResolved, stripEffects } from "../../Diff.ts";
import { canonicalHash } from "../../Local/LocalProvider.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import type { Platform } from "../../Platform.ts";
import type { ProviderService } from "../../Provider.ts";
import type { ResourceClassLike, ResourceLike } from "../../Resource.ts";
import { flociServices } from "./FlociServices.ts";
import { withProviderContext } from "./ProviderContext.ts";

/**
 * The AWS dev sidecar entry URL ([Local.ts](./Local.ts)) — every
 * {@link makeDevWatchProvider} consumer passes this so all floci dev
 * providers share ONE sidecar process.
 */
export const flociSidecarEntry = () =>
  import.meta.resolve(
    import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
    import.meta.url,
  );

/** A diff decision produced by {@link DevWatchSpec.replaceOn}. */
export interface DevReplaceDecision {
  readonly action: "replace";
  readonly deleteFirst?: boolean;
}

/**
 * The context handed to {@link DevWatchSpec.startWatch}. Runs inside the
 * sidecar with the floci override services provided.
 */
export interface DevWatchContext<Props, Attrs> {
  readonly id: string;
  readonly instanceId: string;
  /** The resolved props of the reconcile that started this watcher. */
  readonly news: Props;
  /** Attributes at watch start. */
  readonly attrs: Attrs;
  /** The freshest attributes (updated by {@link rerunReconcile}). */
  readonly currentAttrs: Effect.Effect<Attrs>;
  /**
   * Re-runs the wrapped LIVE reconcile with the latest engine input
   * (props/bindings) and the current attributes as `output`, records and
   * returns the fresh attributes. Serialized with engine reconciles/deletes
   * on the same logical id.
   */
  readonly rerunReconcile: Effect.Effect<Attrs, unknown>;
}

/**
 * The per-resource contract for {@link makeDevWatchProvider}: everything the
 * shared skeleton cannot know about the resource.
 */
export interface DevWatchSpec<Props, Attrs> {
  /**
   * The LIVE provider layer (e.g. `() => FunctionProvider()`). Built inside
   * the floci override context and endpoint-wrapped, exactly like the plain
   * `flociDual` resources.
   */
  readonly liveProvider: () => Layer.Layer<any, any, any>;
  /**
   * Extra service layers built alongside {@link flociServices} inside the
   * override context (e.g. Lambda's fresh `AssetsLive`, whose cached bucket
   * lookup must resolve against the emulator and never share a cache with
   * the live arm's instance).
   */
  readonly services?: Layer.Layer<any, any, any>;
  /**
   * The restart surface of the watch loop: everything that changes WHAT the
   * watcher builds or WHERE it publishes. Plain, canonically-hashable data
   * only — closures degrade to stable placeholders under
   * {@link canonicalHash}. `news` arrives {@link stripEffects}-stripped.
   */
  readonly watchConfigOf: (news: Props, attrs: Attrs) => unknown;
  /**
   * Resource-specific replacement rules, mirroring the LIVE diff's cheap
   * checks (never bundling/building). Checked before the generic dev policy.
   */
  readonly replaceOn?: (input: {
    id: string;
    olds: Props;
    news: Props;
    output: Attrs;
  }) => Effect.Effect<DevReplaceDecision | undefined, never, any>;
  /**
   * Normalization applied to both sides before the structural code-only
   * `noop` equivalence check (e.g. Lambda resolves layer references to ARNs).
   * @default identity
   */
  readonly normalizeProps?: (props: Props) => unknown;
  /**
   * Pin `precreate`'s news to a stub-compatible shape (Lambda pins the
   * handler-affecting props to the 503 stub's own single-module shape).
   * Only consulted when the live provider implements `precreate`.
   */
  readonly transformPrecreateNews?: (news: Props) => Props;
  /**
   * The watch loop, forked (detached, in the provider scope) after every
   * successful reconcile that changes the watch config. Runs with the floci
   * override services provided; failures are logged, never propagated. A
   * spec with nothing to watch for a given props shape simply returns.
   */
  readonly startWatch: (
    ctx: DevWatchContext<Props, Attrs>,
  ) => Effect.Effect<void, any, any>;
}

interface WatchEntry {
  readonly instanceId: string;
  readonly configHash: string;
  fiber: Fiber.Fiber<void, never> | undefined;
  /** The latest engine reconcile input (news/bindings/…) for re-runs. */
  lastInput: any;
  /** The freshest attributes. */
  attrs: any;
}

/**
 * Build an RPC-sidecar-hosted `alchemy dev` provider that delegates its
 * lifecycle to the LIVE provider inside the floci override context and owns
 * a per-resource watch loop. See the module doc for the exact split between
 * the shared skeleton and the {@link DevWatchSpec}.
 */
export const makeDevWatchProvider = <
  R extends ResourceLike,
  Props = R["Props"],
  Attrs = R["Attributes"],
>(
  cls: ResourceClassLike<R> | Platform<R, any, any, any, any>,
  serverEntryUrl: string,
  spec: DevWatchSpec<Props, Attrs>,
) =>
  RpcProvider.effect(
    cls,
    serverEntryUrl,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ambient = yield* Effect.context<never>();

      // The floci override context (emulator endpoint, dummy credentials,
      // account 000000000000) plus any caller-supplied extra services.
      const overrides = yield* Layer.buildWithScope(
        Layer.mergeAll(flociServices(), spec.services ?? Layer.empty).pipe(
          Layer.provide(Layer.succeedContext(ambient)),
        ) as Layer.Layer<any, any, never>,
        scope,
      ).pipe(Effect.orDie);
      const services = Layer.succeedContext(
        Context.merge(ambient, overrides),
      ) as Layer.Layer<any, never, never>;

      // The live provider machinery, every lifecycle method endpoint-wrapped
      // to the emulator — same F1 combinator the plain `flociDual` resources
      // use, applied to a provider instance we build ourselves.
      const liveCtx = yield* Layer.buildWithScope(
        spec
          .liveProvider()
          .pipe(Layer.provide(services)) as unknown as Layer.Layer<
          any,
          any,
          never
        >,
        scope,
      ).pipe(Effect.orDie);
      const live = liveCtx.mapUnsafe.get(cls.Type) as ProviderService<R>;
      const wrapped = withProviderContext(live, services);

      // Sidecar-process watch registry, keyed by logical id. `instanceId`
      // guards a create-first replacement's old-generation delete against
      // killing the successor's watcher.
      const watches = new Map<string, WatchEntry>();

      // Per-id serialization: engine reconciles, watcher re-reconciles, and
      // deletes never interleave for the same logical resource.
      const locks = new Map<string, Semaphore.Semaphore>();
      const withLock = (id: string) => {
        let lock = locks.get(id);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(id, lock);
        }
        return <A, E, Req>(effect: Effect.Effect<A, E, Req>) =>
          Semaphore.withPermits(lock, 1)(effect);
      };

      // Plan-status callbacks don't cross the RPC boundary (functions
      // serialize to `null`) — the live machinery calls `session.note`, so
      // substitute a log-backed session when the wire stripped it.
      const withSafeSession = (input: any) =>
        typeof input?.session?.note === "function"
          ? input
          : {
              ...input,
              session: {
                ...input?.session,
                note: (note: string) => Effect.logDebug(note),
              },
            };

      const ensureWatch = Effect.fn(function* (input: any, attrs: any) {
        const strippedNews = stripEffects(input.news);
        const configHash = yield* canonicalHash(
          spec.watchConfigOf(strippedNews as Props, attrs as Attrs),
        );
        const existing = watches.get(input.id);
        if (
          existing !== undefined &&
          existing.configHash === configHash &&
          existing.instanceId === input.instanceId
        ) {
          // Same watcher keeps running — just refresh the re-run input.
          existing.lastInput = input;
          existing.attrs = attrs;
          return;
        }
        if (existing?.fiber !== undefined) {
          yield* Fiber.interrupt(existing.fiber);
        }
        const entry: WatchEntry = {
          instanceId: input.instanceId,
          configHash,
          fiber: undefined,
          lastInput: input,
          attrs,
        };
        watches.set(input.id, entry);
        const ctx: DevWatchContext<Props, Attrs> = {
          id: input.id,
          instanceId: input.instanceId,
          news: strippedNews as Props,
          attrs: attrs as Attrs,
          currentAttrs: Effect.sync(() => entry.attrs as Attrs),
          rerunReconcile: withLock(input.id)(
            Effect.gen(function* () {
              const fresh = yield* wrapped.reconcile(
                withSafeSession({
                  ...entry.lastInput,
                  olds: entry.lastInput.news,
                  output: entry.attrs,
                }) as any,
              );
              entry.attrs = fresh;
              return fresh as Attrs;
            }),
          ) as Effect.Effect<Attrs, unknown>,
        };
        const fiber = yield* spec.startWatch(ctx).pipe(
          Effect.provide(services),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[alchemy dev] ${input.id}: watch loop exited`,
              cause,
            ),
          ),
          Effect.forkDetach,
          Scope.provide(scope),
        );
        entry.fiber = fiber as Fiber.Fiber<void, never>;
      });

      const stopWatch = Effect.fn(function* (id: string, instanceId: string) {
        const existing = watches.get(id);
        if (existing !== undefined && existing.instanceId === instanceId) {
          watches.delete(id);
          if (existing.fiber !== undefined) {
            yield* Fiber.interrupt(existing.fiber);
          }
        }
      });

      const normalize = (props: Props | undefined): object | undefined =>
        props === undefined
          ? undefined
          : ((spec.normalizeProps?.(props) ?? props) as object);

      const provider: any = {
        // read / precreate / list / tail / logs / stables delegate to the
        // endpoint-wrapped live provider (spreading the Proxy materializes
        // each member through the wrapping `get`).
        ...(wrapped as any),
        diff: Effect.fn(function* ({
          id,
          olds,
          news,
          output,
        }: {
          id: string;
          olds: Props;
          news: Props;
          output: Attrs | undefined;
        }) {
          if (!isResolved(news)) return;
          if (!output) return undefined;
          if (spec.replaceOn !== undefined) {
            const decision = yield* spec.replaceOn({ id, olds, news, output });
            if (decision !== undefined) return decision;
          }
          // A fresh dev session has state rows but no running watcher (and
          // possibly a wiped emulator) — force a reconcile to converge floci
          // and (re)start the watch loop.
          if (!watches.has(id)) return { action: "update" as const };
          if (!havePropsChanged(normalize(olds), normalize(news)!)) {
            // Content-only changes are the watch loop's job — the dev diff
            // never bundles or builds.
            return { action: "noop" as const };
          }
          return { action: "update" as const };
        }),
        reconcile: Effect.fn(function* (input: any) {
          return yield* withLock(input.id)(
            Effect.gen(function* () {
              const attrs = yield* wrapped.reconcile(
                withSafeSession(input) as any,
              );
              yield* ensureWatch(input, attrs);
              return attrs;
            }),
          );
        }),
        delete: Effect.fn(function* (input: any) {
          yield* stopWatch(input.id, input.instanceId);
          yield* withLock(input.id)(
            wrapped.delete(withSafeSession(input) as any),
          );
        }),
      };
      if (typeof (live as any).precreate === "function") {
        provider.precreate = (input: any) =>
          (wrapped as any).precreate(
            withSafeSession({
              ...input,
              news:
                spec.transformPrecreateNews !== undefined
                  ? spec.transformPrecreateNews(input.news)
                  : input.news,
            }),
          );
      }
      return provider;
    }),
  );
