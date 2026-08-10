/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.Lambda.Function`: deploys the function
 * into the floci emulator and hot-swaps its code on file change.
 *
 * Architecture:
 *
 * - **RpcProvider-hosted** — during `alchemy dev` the provider (and its
 *   `Bundle.watch` loops) lives in the AWS dev sidecar
 *   ([AWS/Local/Local.ts](../Local/Local.ts)), surviving user-code hot
 *   reloads of the exec process.
 * - **Reconcile delegates to the LIVE provider machinery** wrapped in the
 *   floci override context ({@link flociServices} +
 *   {@link withProviderContext}): the exact same bundling, IAM role,
 *   binding, and Function URL logic runs — every SDK call just targets the
 *   emulator gateway with the dummy account.
 * - **Watch loop** — after a successful reconcile, a forked `Bundle.watch`
 *   (same rolldown config the deploy used, via
 *   [FunctionBundle](./FunctionBundle.ts)) rebuilds on file change and
 *   uploads the fresh archive to a stable per-function S3 key in the
 *   emulator's assets bucket. The first swap repoints the function's code
 *   at that key with `UpdateFunctionCode`, which enrolls floci's reactive
 *   S3 sync; every later swap is a bare `PutObject` (measured 111–138 ms
 *   re-extract, warm containers drained, no stale invoke).
 * - **Dev diff** — code-only changes are the watch loop's job, so the diff
 *   never bundles: structurally-equal props (minus code) are a `noop`. A
 *   fresh dev session (state row present, no watcher running) forces an
 *   `update` so the emulator state is converged and the watcher starts.
 */

import * as Lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Bundle from "../../Bundle/Bundle.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { havePropsChanged, isResolved, stripEffects } from "../../Diff.ts";
import { canonicalHash } from "../../Local/LocalProvider.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import type { ProviderService } from "../../Provider.ts";
import { Assets, AssetsLive } from "../Assets.ts";
import { flociServices } from "../Local/FlociServices.ts";
import { withProviderContext } from "../Local/ProviderContext.ts";
import {
  Function,
  FunctionProvider,
  layerVersionArnOf,
  type FunctionProps,
} from "./Function.ts";
import {
  makeFunctionBundler,
  type FunctionBundleResult,
} from "./FunctionBundle.ts";

interface WatchEntry {
  readonly instanceId: string;
  readonly configHash: string;
  readonly fiber: Fiber.Fiber<void, never>;
}

/**
 * The restart surface of a watch loop: everything that changes WHAT the
 * watcher builds or WHERE it uploads. Plain data only — `build` may carry
 * plugin closures, which degrade to stable placeholders under
 * {@link canonicalHash}'s JSON canonicalization.
 */
const watchConfigOf = (news: FunctionProps, functionName: string) => ({
  functionName,
  main: news.main,
  handler: news.handler,
  bundle: news.bundle,
  isExternal: news.isExternal,
  runtime: news.runtime,
  architecture: news.architecture,
  uploadSourceMap: news.uploadSourceMap,
  build: news.build,
});

export const FlociFunctionProvider = () =>
  RpcProvider.effect(
    Function,
    import.meta.resolve(
      import.meta.url.endsWith(".ts")
        ? "../Local/Local.ts"
        : "../Local/Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ambient = yield* Effect.context<never>();
      const bundler = yield* makeFunctionBundler;

      // The floci override context (emulator endpoint, dummy credentials,
      // account 000000000000) plus a FRESH `Assets` instance: its cached
      // bucket lookup must resolve against the emulator (auto-bootstrapped
      // there) and can never share a cache with the live arm's instance.
      const overrides = yield* Layer.buildWithScope(
        Layer.mergeAll(flociServices(), AssetsLive).pipe(
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
        FunctionProvider().pipe(
          Layer.provide(services),
        ) as unknown as Layer.Layer<any, any, never>,
        scope,
      ).pipe(Effect.orDie);
      const live = liveCtx.mapUnsafe.get(
        Function.Type,
      ) as ProviderService<Function>;
      const wrapped = withProviderContext(live, services);

      // Sidecar-process watch registry, keyed by logical id. `instanceId`
      // guards a create-first replacement's old-generation delete against
      // killing the successor's watcher.
      const watches = new Map<string, WatchEntry>();

      const runWatch = (
        props: FunctionProps,
        functionName: string,
        initialHash: string,
      ): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const assets = yield* Assets;
          let lastHash = initialHash;
          let enrolledKey: string | undefined;
          let startedAt = Date.now();

          const swap = Effect.fn(function* (result: FunctionBundleResult) {
            if (result.identityHash === lastHash) return;
            const { archive } = yield* result.buildArchive;
            const bucket = yield* assets.bucketName;
            const key = `lambda/dev/${functionName}.zip`;
            yield* s3.putObject({
              Bucket: bucket,
              Key: key,
              Body: archive,
              ContentType: "application/zip",
            });
            if (enrolledKey !== key) {
              // First swap: repoint the function's code at the stable dev
              // key — floci's reactive S3 sync then re-extracts on every
              // subsequent PutObject with no further Lambda API calls.
              yield* Lambda.updateFunctionCode({
                FunctionName: functionName,
                S3Bucket: bucket,
                S3Key: key,
              }).pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ResourceConflictException",
                  schedule: Schedule.exponential(50),
                  times: 8,
                }),
              );
              enrolledKey = key;
            }
            lastHash = result.identityHash;
            yield* Effect.logInfo(
              `[alchemy dev] ${functionName}: code swapped in ${Date.now() - startedAt}ms`,
            );
          });

          if (props.bundle === false) {
            // Prebuilt directory: no module graph to watch — fs-watch the
            // directory and re-zip it as-is (exactly like `prebuiltCode`).
            const fs = yield* FileSystem.FileSystem;
            const realMain = yield* TempRoot.resolveMainPath(props.main);
            const dir = realMain.slice(0, realMain.lastIndexOf("/"));
            yield* fs.watch(dir, { recursive: true }).pipe(
              Stream.debounce("200 millis"),
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  startedAt = Date.now();
                  const result = yield* bundler.prebuiltCode(realMain);
                  yield* swap(result);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[alchemy dev] ${functionName}: code swap failed`,
                      cause,
                    ),
                  ),
                ),
              ),
            );
          } else {
            // The exact rolldown config the deploy used — incremental
            // rebuilds produce the identical artifact shape.
            const plan = yield* bundler.resolveBundlePlan(props);
            yield* Bundle.watch(
              plan.inputOptions,
              plan.outputOptions,
              plan.extra,
            ).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "Start": {
                      startedAt = Date.now();
                      return;
                    }
                    case "Error": {
                      yield* Effect.logWarning(
                        `[alchemy dev] ${functionName}: rebuild failed: ${event.error.message}`,
                      );
                      return;
                    }
                    case "Success": {
                      const result = yield* bundler.finishBundle(
                        plan,
                        event.output,
                      );
                      yield* swap(result);
                    }
                  }
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[alchemy dev] ${functionName}: code swap failed`,
                      cause,
                    ),
                  ),
                ),
              ),
            );
          }
        }).pipe(
          Effect.provide(services),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[alchemy dev] ${functionName}: watch loop exited`,
              cause,
            ),
          ),
        ) as Effect.Effect<void, never, never>;

      const ensureWatch = Effect.fn(function* (input: {
        id: string;
        instanceId: string;
        news: FunctionProps;
        functionName: string;
        codeHash: string;
      }) {
        const configHash = yield* canonicalHash(
          watchConfigOf(stripEffects(input.news), input.functionName),
        );
        const existing = watches.get(input.id);
        if (
          existing !== undefined &&
          existing.configHash === configHash &&
          existing.instanceId === input.instanceId
        ) {
          return;
        }
        if (existing !== undefined) {
          yield* Fiber.interrupt(existing.fiber);
        }
        const fiber = yield* runWatch(
          input.news,
          input.functionName,
          input.codeHash,
        ).pipe(Effect.forkDetach, Scope.provide(scope));
        watches.set(input.id, {
          instanceId: input.instanceId,
          configHash,
          fiber,
        });
      });

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

      const stopWatch = Effect.fn(function* (id: string, instanceId: string) {
        const existing = watches.get(id);
        if (existing !== undefined && existing.instanceId === instanceId) {
          watches.delete(id);
          yield* Fiber.interrupt(existing.fiber);
        }
      });

      return {
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
          olds: FunctionProps;
          news: FunctionProps;
          output: Function["Attributes"] | undefined;
        }) {
          if (!isResolved(news)) return;
          if (!output) return undefined;
          // Mirrors the live diff's replacement rules.
          const newFunctionName = news.functionName ?? output.functionName;
          if (output.functionName !== newFunctionName) {
            return { action: "replace" as const };
          }
          if (!!olds.durableConfig !== !!news.durableConfig) {
            return { action: "replace" as const };
          }
          // A fresh dev session has state rows but no running watcher (and
          // possibly a wiped emulator) — force a reconcile to converge floci
          // and (re)start the watch loop.
          if (!watches.has(id)) return { action: "update" as const };
          const normalizeLayers = (props: FunctionProps) => ({
            ...props,
            layers: (props.layers ?? []).map(layerVersionArnOf),
          });
          if (!havePropsChanged(normalizeLayers(olds), normalizeLayers(news))) {
            // Code-only changes are the watch loop's job — the dev diff
            // never bundles.
            return { action: "noop" as const };
          }
          return { action: "update" as const };
        }),
        precreate: (input: any) =>
          (wrapped as any).precreate(
            withSafeSession({
              ...input,
              // Floci validates the Handler FILE against the package at
              // CreateFunction (AWS defers that to first invoke). The
              // precreate 503 stub ships a single `index.*` module, so a
              // `bundle: false` / custom-handler props set (`handler.handler`)
              // would be rejected — pin the stub's handler-affecting props to
              // the stub's own shape; `reconcile` applies the real Handler
              // together with the real package.
              news: {
                ...input.news,
                bundle: undefined,
                isExternal: undefined,
                handler: undefined,
              },
            }),
          ),
        reconcile: Effect.fn(function* (input: any) {
          const attrs = yield* wrapped.reconcile(withSafeSession(input) as any);
          yield* ensureWatch({
            id: input.id,
            instanceId: input.instanceId,
            news: input.news,
            functionName: attrs.functionName,
            codeHash: attrs.code?.hash ?? "",
          });
          return attrs;
        }),
        delete: Effect.fn(function* (input: any) {
          yield* stopWatch(input.id, input.instanceId);
          yield* wrapped.delete(input);
        }),
      } as any;
    }),
  );
