/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.ECS.Task`: deploys the task
 * definition (image, roles, log group, ECR repository) into the floci
 * emulator and hot-swaps running tasks on file change.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)); this file supplies
 * only the Task-specific parts:
 *
 * - **Watch triggers** by image source ({@link imageSourceTrigger}):
 *   `main` re-uses the deploy's exact rolldown module graph via
 *   `Bundle.watch`; `context` fs-watches the Docker build context;
 *   registry `image` refs have nothing local to watch.
 * - **Swap mechanism** — every trigger re-runs the LIVE reconcile against
 *   the emulator: the image pipeline is content-addressed, so a real change
 *   builds and pushes a NEW `<repositoryUri>:<hash>` tag and registers a
 *   new task definition revision (an unchanged hash is a cheap no-op).
 *   RUNNING standalone tasks of the family (launched via `RunTask`) are
 *   then stopped and re-run on the new revision — service-managed tasks
 *   belong to [FlociServiceProvider](./FlociServiceProvider.ts).
 */

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ImageSourceLike } from "../ECR/ImageSource.ts";
import {
  flociSidecarEntry,
  makeDevWatchProvider,
} from "../Local/DevWatchProvider.ts";
import { imageSourceTrigger, restartFamilyTasks } from "./EcsDevWatch.ts";
import { Task, TaskProvider, type TaskProps } from "./Task.ts";

export const FlociTaskProvider = () =>
  makeDevWatchProvider<Task, TaskProps, Task["Attributes"]>(
    Task,
    flociSidecarEntry(),
    {
      liveProvider: () => TaskProvider(),
      // The restart surface of the watch loop: everything that changes WHAT
      // the watcher builds or WHERE it publishes/runs.
      watchConfigOf: (news, attrs) => {
        const source = news as ImageSourceLike;
        return {
          family: attrs.taskFamily,
          repositoryName: attrs.repositoryName,
          main: source.main,
          handler: source.handler,
          build: source.build,
          isExternal: news.isExternal,
          context: source.context,
          dockerfile: source.dockerfile,
          image: source.image,
          port: news.port,
          runtimePlatform: news.runtimePlatform,
        };
      },
      // Mirrors the live diff's replacement rule: the family (taskName, or
      // the id-derived generated name) is the identity.
      replaceOn: ({ olds, news }) =>
        Effect.sync(() =>
          (olds.taskName ?? null) !== (news.taskName ?? null)
            ? { action: "replace" as const }
            : undefined,
        ),
      startWatch: (ctx) =>
        Effect.gen(function* () {
          const trigger = yield* imageSourceTrigger({
            id: ctx.id,
            source: ctx.news as ImageSourceLike,
            isExternal: ctx.news.isExternal,
          });
          yield* trigger.pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                const startedAt = Date.now();
                const previous = yield* ctx.currentAttrs;
                const attrs = yield* ctx.rerunReconcile;
                if (attrs.code.hash === previous.code.hash) return;
                const restarted = yield* restartFamilyTasks({
                  family: attrs.taskFamily,
                  nextTaskDefinitionArn: attrs.taskDefinitionArn,
                  serviceManaged: false,
                });
                yield* Effect.logInfo(
                  `[alchemy dev] ${attrs.taskFamily}: image swapped (${restarted} task(s) restarted) in ${Date.now() - startedAt}ms`,
                );
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `[alchemy dev] ${ctx.id}: image swap failed`,
                    cause,
                  ),
                ),
              ),
            ),
          );
        }),
    },
  );
