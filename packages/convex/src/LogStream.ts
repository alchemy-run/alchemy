import * as deployment from "@distilled.cloud/convex/deployment";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { DeploymentAttributes } from "./Deployment.ts";
import { GONE, onDeployment } from "./internal/deployment.ts";
import type { Providers } from "./Providers.ts";

export interface LogStreamProps {
  /** The deployment whose logs to send. Changing it replaces the stream. */
  deployment: Pick<DeploymentAttributes, "url">;
  /**
   * Where the logs go, named by `logStreamType`: `axiom`, `datadog`, `s3`,
   * `sentry`, `webhook` and others. Changing the type replaces the stream.
   */
  config: deployment.CreateLogStreamArgs;
}

export interface LogStreamAttributes {
  /** The stream's ID. */
  logStreamId: string;
  /** The URL of the deployment this stream reads. */
  deploymentUrl: string;
  /** Where the logs go. */
  logStreamType: string;
  /** The secret that signs webhook requests. Convex returns it only at creation. */
  hmacSecret: Redacted.Redacted<string> | undefined;
}

export type LogStream = Resource<
  "Convex.LogStream",
  LogStreamProps,
  LogStreamAttributes,
  never,
  Providers
>;

/**
 * A log stream from a Convex deployment to another service.
 *
 * :::caution
 * Log streams need the Convex Professional plan. Below it, a deploy fails with
 * `LogStreamingNotEnabled`.
 * :::
 *
 * A deployment has at most one stream of each type.
 *
 * ### Sending Logs
 * **Example:** Send logs to a webhook
 * ```typescript
 * const stream = yield* Convex.LogStream("Logs", {
 *   deployment,
 *   config: {
 *     logStreamType: "webhook",
 *     url: "https://example.com/logs",
 *     format: "json",
 *   },
 * });
 * ```
 *
 * @see https://docs.convex.dev/production/integrations/log-streams
 *
 * @resource
 * @product Observability
 */
export const LogStream = Resource<LogStream>("Convex.LogStream");

const list = (url: string) => onDeployment(url, deployment.listLogStreams({}));

const typeOf = (stream: deployment.LogStreamConfig) => stream.logStreamType;

export const LogStreamProvider = () =>
  Provider.effect(
    LogStream,
    Effect.succeed({
      stables: ["logStreamId", "deploymentUrl", "logStreamType"],
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (
          (output !== undefined && news.deployment.url !== output.deploymentUrl) ||
          (olds !== undefined && news.config.logStreamType !== olds.config.logStreamType)
        ) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const url = output?.deploymentUrl ?? olds?.deployment.url;
        if (url === undefined) return undefined;
        const streams = yield* list(url);
        if (output !== undefined) {
          return streams.some((stream) => stream.id === output.logStreamId) ? output : undefined;
        }
        const stream = streams.find((item) => typeOf(item) === olds?.config.logStreamType);
        return (
          stream &&
          Unowned({
            logStreamId: stream.id,
            deploymentUrl: url,
            logStreamType: typeOf(stream),
            hmacSecret: undefined,
          })
        );
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const url = news.deployment.url;
        const type = news.config.logStreamType;

        // Observe
        const streams = yield* list(url);
        const current =
          streams.find((stream) => stream.id === output?.logStreamId) ??
          streams.find((stream) => typeOf(stream) === type);

        // Ensure. Webhook secrets arrive as plain strings, so wrap them here.
        if (current === undefined) {
          yield* session.note(`Creating ${type} log stream...`);
          const created = yield* onDeployment(
            url,
            deployment.createLogStream({ body: news.config }),
          );
          return {
            logStreamId: created.id,
            deploymentUrl: url,
            logStreamType: created.logStreamType,
            hmacSecret: "hmacSecret" in created ? Redacted.make(created.hmacSecret) : undefined,
          };
        }

        // Sync. Convex hides stored secrets, so the config can't be compared.
        yield* onDeployment(
          url,
          deployment.updateLogStream({
            id: current.id,
            body: news.config as deployment.UpdateLogStreamArgs,
          }),
        );
        return {
          logStreamId: current.id,
          deploymentUrl: url,
          logStreamType: type,
          hmacSecret: output?.hmacSecret,
        };
      }),
      // Streams live on their deployment and go with it.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* onDeployment(
          output.deploymentUrl,
          deployment.deleteLogStream({ id: output.logStreamId }),
        ).pipe(
          Effect.catchTag("InvalidLogStreamId", () => Effect.void),
          Effect.catchTag(GONE, () => Effect.void),
        );
      }),
    }),
  );
