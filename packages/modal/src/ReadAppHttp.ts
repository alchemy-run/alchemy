import * as app from "@distilled.cloud/modal/app";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { operations, stringMap, timestampOf } from "./internal.ts";
import { ReadApp, type AppLogFilter, type AppLogLine, type AppReader } from "./ReadApp.ts";

const STREAM = {
  stdout: "FILE_DESCRIPTOR_STDOUT",
  stderr: "FILE_DESCRIPTOR_STDERR",
  info: "FILE_DESCRIPTOR_INFO",
} as const;

const streamOf = (fd: string | undefined): AppLogLine["stream"] =>
  fd === STREAM.stdout
    ? "stdout"
    : fd === STREAM.stderr
      ? "stderr"
      : fd === STREAM.info
        ? "info"
        : undefined;

const filterOf = (filter: AppLogFilter) => ({
  functionId: filter.functionId,
  functionCallId: filter.functionCallId,
  taskId: filter.containerId,
  sandboxId: filter.sandboxId,
  searchText: filter.search,
  source: filter.stream ? STREAM[filter.stream] : undefined,
});

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const ReadAppOps = operations({
  fetchLogs: app.appFetchLogs,
  getLogs: app.appGetLogs,
  countLogs: app.appCountLogs,
  info: app.appGetInfo,
  lifecycle: app.appGetLifecycle,
  layout: app.appGetLayout,
  deployments: app.appDeploymentHistory,
});

export type ReadAppOps = Effect.Success<typeof ReadAppOps>;

/**
 * {@link ReadApp} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `viewer` role on the App's environment.
 *
 * @layer
 * @product App
 * @provides Modal.ReadApp
 */
export const ReadAppHttp = Layer.effect(
  ReadApp,
  makeModalBinding({
    tag: "Modal.ReadApp",
    operations: ReadAppOps,
    role: "viewer",
    make: Effect.fn(function* (target: App, ops) {
      const appId = yield* target.appId;
      return {
        logs: (query) =>
          Effect.flatMap(appId, (id) =>
            ops.fetchLogs({
              appId: id,
              since: timestampOf(query.since),
              until: timestampOf(query.until ?? Date.now()),
              limit: query.limit,
              ...filterOf(query),
            }),
          ).pipe(
            Effect.map((response) =>
              (response.batches ?? []).flatMap((batch) =>
                (batch.items ?? []).map((line) => ({
                  data: line.data ?? "",
                  timestamp: line.timestamp,
                  stream: streamOf(line.fileDescriptor),
                  functionId: batch.functionId,
                  functionCallId: line.functionCallId,
                  containerId: line.containerId ?? batch.taskId,
                  sandboxId: batch.sandboxId,
                })),
              ),
            ),
          ),
        tail: (query = {}) =>
          Effect.flatMap(appId, (id) =>
            ops.getLogs({
              appId: id,
              timeout: query.timeout ?? 10,
              lastEntryId: query.cursor,
              functionId: query.functionId,
              functionCallId: query.functionCallId,
              taskId: query.containerId,
              sandboxId: query.sandboxId,
              searchText: query.search,
              fileDescriptor: query.stream ? STREAM[query.stream] : undefined,
            }),
          ).pipe(
            Effect.map(({ items }) => ({
              lines: items.flatMap((batch) =>
                (batch.items ?? []).map((line) => ({
                  data: line.data ?? "",
                  timestamp: line.timestamp,
                  stream: streamOf(line.fileDescriptor),
                  functionId: batch.functionId,
                  functionCallId: line.functionCallId,
                  containerId: line.containerId ?? batch.taskId,
                  sandboxId: batch.sandboxId,
                })),
              ),
              cursor: items.findLast((batch) => batch.entryId)?.entryId ?? query.cursor,
            })),
          ),
        logCount: (query) =>
          Effect.flatMap(appId, (id) =>
            ops.countLogs({
              appId: id,
              since: timestampOf(query.since),
              until: timestampOf(query.until ?? Date.now()),
              bucketSecs: query.bucketSecs,
              ...filterOf(query),
            }),
          ),
        info: () => Effect.flatMap(appId, (id) => ops.info({ appId: id })),
        lifecycle: () =>
          Effect.flatMap(appId, (id) => ops.lifecycle({ appId: id })).pipe(
            Effect.map((response) => response.lifecycle),
          ),
        layout: () =>
          Effect.flatMap(appId, (id) => ops.layout({ appId: id })).pipe(
            Effect.map(({ appLayout }) => ({
              functionIds: stringMap(appLayout?.functionIds),
              classIds: stringMap(appLayout?.classIds),
            })),
          ),
        deployments: () => Effect.flatMap(appId, (id) => ops.deployments({ appId: id })),
      } satisfies AppReader;
    }),
  }),
);
