import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "./internal/Client.ts";
import { toRedacted, unwrapOptionalSecret } from "./internal/Redacted.ts";
import type { Providers } from "./Providers.ts";
import type { LogStreamPreviewSetting, SecretString } from "./Types.ts";

export interface LogStreamProps {
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Syslog/TLS endpoint to stream workspace logs to. */
  endpoint: string;
  /** Optional authentication token paired with `endpoint`. */
  token?: SecretString;
  /** Whether preview environment logs are sent (`"send"`) or dropped (`"drop"`). Defaults to `"send"`. */
  preview?: LogStreamPreviewSetting;
}

export interface LogStreamAttributes {
  /** Workspace/owner ID owning this log stream singleton. */
  ownerId: string;
  /** Active log ingestion endpoint URL. */
  endpoint?: string;
  /** Whether preview logs are sent or dropped. */
  preview: LogStreamPreviewSetting;
  /** Redacted authentication token retained in state, if provided. */
  token?: Redacted.Redacted<string>;
}

export interface LogStreamLookup {
  /** Optional owner ID whose workspace log stream setting should be read. */
  ownerId?: string;
}

export type LogStream = Resource<
  "Render.LogStream",
  LogStreamProps,
  LogStreamAttributes,
  never,
  Providers,
  LogStreamLookup
>;

/**
 * Configures the workspace-wide log stream destination (`syslog` / compatible
 * collector) and preview environment forwarding setting.
 *
 * This is a workspace singleton; deleting it removes the log stream destination.
 *
 * **Example:** Forward workspace logs
 * ```typescript
 * const logs = yield* Render.LogStream("WorkspaceLogs", {
 *   endpoint: "intake.logs.example.com:6514",
 *   token: yield* Config.Redacted("LOG_STREAM_TOKEN"),
 *   preview: "drop",
 * });
 * ```
 *
 * @resource
 * @product Observability
 * @category Observability & Events
 */
export const LogStream = Resource<LogStream>("Render.LogStream");

export const LogStreamProvider = () =>
  Provider.effect(
    LogStream,
    Effect.succeed({
      stables: ["ownerId"],
      nuke: { singleton: true },
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const ownerId = output?.ownerId ?? (yield* Client.resolveOwnerId(explicitOwnerId));
        const setting = yield* Client.ignoreNotFound(Client.getOwnerLogStream(ownerId));
        if (!setting || !setting.endpoint) return undefined;
        return {
          ownerId: setting.ownerId ?? ownerId,
          endpoint: setting.endpoint,
          preview: setting.preview ?? "send",
          ...(output?.token !== undefined ? { token: output.token } : {}),
        };
      }),
      lookup: Effect.fn(function* (props) {
        const ownerId = yield* Client.resolveOwnerId(props.ownerId);
        const setting = yield* Client.ignoreNotFound(Client.getOwnerLogStream(ownerId));
        if (!setting || !setting.endpoint) return undefined;
        return {
          ownerId: setting.ownerId ?? ownerId,
          endpoint: setting.endpoint,
          preview: setting.preview ?? "send",
        };
      }),
      list: Effect.fn(function* () {
        return [];
      }),
      reconcile: Effect.fn(function* ({ news }) {
        const ownerId = yield* Client.resolveOwnerId(news.ownerId);
        const token = unwrapOptionalSecret(news.token);
        const updated = yield* Client.putOwnerLogStream(ownerId, {
          preview: news.preview ?? "send",
          endpoint: news.endpoint,
          ...(token !== undefined ? { token } : {}),
        });
        return {
          ownerId: updated.ownerId ?? ownerId,
          endpoint: updated.endpoint ?? news.endpoint,
          preview: updated.preview ?? news.preview ?? "send",
          ...(news.token !== undefined ? { token: toRedacted(news.token) } : {}),
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.ownerId) return;
        yield* Client.deleteOwnerLogStream(output.ownerId);
      }),
    }),
  );
