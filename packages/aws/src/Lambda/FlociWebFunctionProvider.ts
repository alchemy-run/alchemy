/**
 * The `alchemy dev` provider for `AWS.Lambda.WebFunction`: deploys the
 * function into the floci emulator and hot-swaps its code on file change.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)), like
 * [FlociFunctionProvider](./FlociFunctionProvider.ts). This file supplies the
 * Web Function parts:
 *
 * - **Watch loop** — a forked `Bundle.watch` with the rolldown config the
 *   deploy used rebuilds on file change. A revision is immutable and floci
 *   copies its code when it is created, so a swap can't overwrite code in
 *   place the way a Lambda Function swap does. It uploads the archive to the
 *   content-addressed key the live reconcile would use, creates a revision
 *   from the one the built-in endpoint serves with only the code replaced,
 *   and sends all of the endpoint's traffic to it. The first request after a
 *   swap starts an environment of the new revision. `bundle: false` props
 *   fs-watch the prebuilt directory instead.
 * - **Locked swaps** — a swap runs under the skeleton's per-id lock and
 *   copies the revision the latest engine reconcile published, so it keeps
 *   the environment, role and limits that reconcile applied.
 * - **Replacement rules** — a functionName change replaces, mirroring the
 *   live diff.
 */

import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as TempRoot from "alchemy/Bundle/TempRoot";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Assets, AssetsLive } from "../Assets.ts";
import { flociProvidersUrl, makeDevWatchProvider } from "../Local/DevWatchProvider.ts";
import { makeFunctionBundler, type FunctionBundleResult } from "./FunctionBundle.ts";
import { WebFunction, WebFunctionProvider, type WebFunctionProps } from "./WebFunction.ts";
import { toWebFunctionZipProps, webFunctionBundleOptions } from "./WebFunctionBundle.ts";
import { WebFunctionFailed } from "./WebFunctionEndpointSync.ts";

export const FlociWebFunctionProvider = () =>
  makeDevWatchProvider<WebFunction, WebFunctionProps, WebFunction["Attributes"]>(
    WebFunction,
    flociProvidersUrl(),
    {
      liveProvider: () => WebFunctionProvider(),
      // A FRESH `Assets` instance, whose bucket lookup resolves against the
      // emulator, as in FlociFunctionProvider.
      services: AssetsLive,
      watchConfigOf: (news, attrs) => ({
        functionName: attrs.functionName,
        main: news.main,
        bundle: news.bundle,
        uploadSourceMap: news.uploadSourceMap,
        build: news.build,
      }),
      replaceOn: ({ news, output }) =>
        Effect.sync(() =>
          (news.functionName ?? output.functionName) !== output.functionName
            ? { action: "replace" as const }
            : undefined,
        ),
      startWatch: (ctx) =>
        Effect.gen(function* () {
          const props = ctx.news;
          const functionName = ctx.attrs.functionName;
          const bundler = yield* makeFunctionBundler;
          const assets = yield* Assets;
          // The attributes of the engine reconcile the last swap started
          // from. Each engine reconcile publishes a revision of its own, so
          // a new attributes object resets what the endpoint serves.
          let reconciled: WebFunction["Attributes"] | undefined;
          let revisionId = "";
          let lastHash = "";
          let startedAt = yield* Clock.currentTimeMillis;

          const swap = Effect.fn(function* (result: FunctionBundleResult) {
            const current = yield* ctx.currentAttrs;
            if (current !== reconciled) {
              reconciled = current;
              revisionId = current.revisionId;
              lastHash = current.code.hash;
            }
            if (result.identityHash === lastHash) return;
            const { archive, archiveHash } = yield* result.buildArchive;
            const bucket = yield* assets.bucketName;
            const key = yield* assets.uploadAsset(`web/${archiveHash}`, archive);
            const served = yield* LambdaWeb.getWebFunctionRevision({ functionName, revisionId });
            const { revisionId: created } = yield* LambdaWeb.createWebFunctionRevision({
              functionName,
              description: served.description,
              kmsKeyArn: served.kmsKeyArn,
              buildConfig: {
                ...served.buildConfig,
                codeConfig: { s3Object: { bucket, key } },
              },
              serviceConfig: served.serviceConfig,
            });
            // floci answers a create with Pending but has already stored the
            // revision Active, or Failed when it can't keep the code.
            const revision = yield* LambdaWeb.getWebFunctionRevision({
              functionName,
              revisionId: created,
            });
            if (revision.state === "Failed") {
              return yield* new WebFunctionFailed({
                functionName,
                resource: `revision ${created}`,
                reason: [
                  revision.stateReason,
                  ...(revision.errors ?? []).map(
                    (e) => `${e.attribute}: ${e.errorCode} ${e.errorMessage}`,
                  ),
                ].join("; "),
              });
            }
            // A canary would keep the edit from most requests, so dev sends
            // all traffic to the new revision.
            yield* LambdaWeb.updateWebFunctionEndpoint({
              functionName,
              endpointName: current.endpointName,
              revisionWeights: [{ revisionId: created, weight: 100 }],
            }).pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "ConflictException",
                schedule: Schedule.exponential(50),
                times: 8,
              }),
            );
            revisionId = created;
            lastHash = result.identityHash;
            yield* Effect.logInfo(
              `code swapped in ${(yield* Clock.currentTimeMillis) - startedAt}ms`,
            );
          }, ctx.withLock);

          if (props.bundle === false) {
            const fs = yield* FileSystem.FileSystem;
            const realMain = yield* TempRoot.resolveMainPath(props.main);
            const dir = realMain.slice(0, realMain.lastIndexOf("/"));
            yield* fs.watch(dir, { recursive: true }).pipe(
              Stream.debounce("200 millis"),
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  startedAt = yield* Clock.currentTimeMillis;
                  const result = yield* bundler.prebuiltCode(realMain);
                  yield* swap(result);
                }).pipe(Effect.catchCause((cause) => Effect.logWarning(`code swap failed`, cause))),
              ),
            );
          } else {
            const plan = yield* bundler.resolveBundlePlan(
              toWebFunctionZipProps(props),
              webFunctionBundleOptions,
            );
            yield* Bundle.watch(plan.inputOptions, plan.outputOptions, plan.extra).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "Start": {
                      startedAt = yield* Clock.currentTimeMillis;
                      return;
                    }
                    case "Error": {
                      yield* Effect.logWarning(`rebuild failed: ${event.error.message}`);
                      return;
                    }
                    case "Success": {
                      const result = yield* bundler.finishBundle(plan, event.output);
                      yield* swap(result);
                    }
                  }
                }).pipe(Effect.catchCause((cause) => Effect.logWarning(`code swap failed`, cause))),
              ),
            );
          }
        }),
    },
  );
