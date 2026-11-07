import type * as app from "@distilled.cloud/modal/app";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { OpError } from "./internal.ts";
import type { ReadAppOps } from "./ReadAppHttp.ts";
import type { TimeRange } from "./ReadFunction.ts";

/** One log line. */
export interface AppLogLine {
  readonly data: string;
  /** Epoch seconds. */
  readonly timestamp: number | undefined;
  readonly stream: "stdout" | "stderr" | "info" | undefined;
  readonly functionId: string | undefined;
  readonly functionCallId: string | undefined;
  readonly containerId: string | undefined;
  readonly sandboxId: string | undefined;
}

/** Filters for an App's logs. */
export interface AppLogFilter {
  readonly functionId?: string;
  readonly functionCallId?: string;
  readonly containerId?: string;
  readonly sandboxId?: string;
  readonly search?: string;
  readonly stream?: "stdout" | "stderr" | "info";
}

/** Observe an App: logs, functions, and deployment history. */
export interface AppReader {
  /** Log lines in a time range, oldest first. */
  logs(
    query: TimeRange & AppLogFilter & { readonly limit?: number },
  ): Effect.Effect<ReadonlyArray<AppLogLine>, OpError<ReadAppOps, "fetchLogs">, RuntimeContext>;
  /**
   * Follow the App's logs: lines after `cursor` (or the latest), waiting up
   * to `timeout` for new ones. Pass the returned cursor to the next call.
   */
  tail(
    query?: AppLogFilter & { readonly cursor?: string; readonly timeout?: number },
  ): Effect.Effect<
    { readonly lines: ReadonlyArray<AppLogLine>; readonly cursor: string | undefined },
    OpError<ReadAppOps, "getLogs">,
    RuntimeContext
  >;
  /** Log lines per time bucket. */
  logCount(
    query: TimeRange & AppLogFilter & { readonly bucketSecs?: number },
  ): Effect.Effect<app.AppCountLogsResponse, OpError<ReadAppOps, "countLogs">, RuntimeContext>;
  /** The App's metadata and a summary of each function. */
  info(): Effect.Effect<app.AppGetInfoResponse, OpError<ReadAppOps, "info">, RuntimeContext>;
  /** When the App was created, deployed and stopped, and by whom. */
  lifecycle(): Effect.Effect<
    app.AppLifecycle | undefined,
    OpError<ReadAppOps, "lifecycle">,
    RuntimeContext
  >;
  /** The functions and classes the App serves, by name. */
  layout(): Effect.Effect<
    { readonly functionIds: Record<string, string>; readonly classIds: Record<string, string> },
    OpError<ReadAppOps, "layout">,
    RuntimeContext
  >;
  /** Every deployed version, and the version in production. */
  deployments(): Effect.Effect<
    app.AppDeploymentHistoryResponse,
    OpError<ReadAppOps, "deployments">,
    RuntimeContext
  >;
}

/**
 * Read a Modal App from any runtime: its logs (every function, server and
 * sandbox in it), function summaries and deployment history.
 *
 * ### Logs
 * **Example:** Errors from the last hour
 * ```typescript
 * const backend = yield* Modal.ReadApp(Backend);
 * const lines = yield* backend.logs({ since: new Date(Date.now() - 3_600_000), stream: "stderr" });
 * ```
 *
 * ### Deployments
 * **Example:** The version in production
 * ```typescript
 * const { productionAppVersion } = yield* backend.deployments();
 * ```
 *
 * @binding
 * @product App
 */
export interface ReadApp extends Binding.Service<
  ReadApp,
  "Modal.ReadApp",
  (app: App) => Effect.Effect<AppReader>
> {}

export const ReadApp = Binding.Service<ReadApp>("Modal.ReadApp");
