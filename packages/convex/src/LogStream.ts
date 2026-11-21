import * as deployment from "@distilled.cloud/convex/deployment";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { DeploymentAttributes } from "./Deployment.ts";
import { GONE, onDeployment } from "./internal/deployment.ts";
import { createOnce } from "./internal/retry.ts";
import type { Providers } from "./Providers.ts";

/** Convex said a stream of this type exists, but didn't list it. */
export class LogStreamNotListed extends Data.TaggedError("LogStreamNotListed")<{
  readonly message: string;
}> {}

export interface LogStreamProps {
  /** The deployment whose logs to send. Changing it replaces the stream. */
  deployment: Pick<DeploymentAttributes, "url">;
  /**
   * Where the logs go, named by `logStreamType`: `axiom`, `datadog`, `s3Export`,
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
  /** The secret that signs webhook requests. Only a `webhook` stream has one. */
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

// Convex serves log streams from its integrations routes.
const list = (url: string) => onDeployment(url, deployment.listIntegrations({}));

const typeOf = (stream: deployment.LogStreamConfig) => stream.logStreamType;

/** A webhook stream carries its signing secret as a plain string, so wrap it. */
const secretOf = (stream: deployment.LogStreamConfig | deployment.CreateIntegrationResponse) =>
  "hmacSecret" in stream ? Redacted.make(stream.hmacSecret) : undefined;

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
          const stream = streams.find((item) => item.id === output.logStreamId);
          // The secret can be rotated outside the stack, so take the live one.
          return stream && { ...output, hmacSecret: secretOf(stream) };
        }
        const stream = streams.find((item) => typeOf(item) === olds?.config.logStreamType);
        return (
          stream &&
          Unowned({
            logStreamId: stream.id,
            deploymentUrl: url,
            logStreamType: typeOf(stream),
            hmacSecret: secretOf(stream),
          })
        );
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const url = news.deployment.url;
        const type = news.config.logStreamType;
        const observe = list(url).pipe(
          Effect.map(
            (streams) =>
              streams.find((stream) => stream.id === output?.logStreamId) ??
              streams.find((stream) => typeOf(stream) === type),
          ),
        );

        // Observe
        let current = yield* observe;

        // Ensure. A deployment has one stream per type, so a create that loses
        // a race to another deploy syncs the winner's stream instead.
        if (current === undefined) {
          yield* session.note(`Creating ${type} log stream...`);
          const created = yield* onDeployment(
            url,
            createOnce(deployment.createIntegration({ body: news.config })),
          ).pipe(Effect.catchTag("LogStreamAlreadyExists", () => Effect.undefined));
          if (created !== undefined) {
            return {
              logStreamId: created.id,
              deploymentUrl: url,
              logStreamType: created.logStreamType,
              hmacSecret: secretOf(created),
            };
          }
          current = yield* observe;
          if (current === undefined) {
            return yield* new LogStreamNotListed({
              message: `Convex: a ${type} log stream exists on ${url}, but the deployment doesn't list it.`,
            });
          }
        }

        // Sync. Convex hides stored API keys, so the config can't be compared.
        yield* onDeployment(
          url,
          deployment.updateIntegration({
            id: current.id,
            body: news.config as deployment.UpdateLogStreamArgs,
          }),
        );
        return {
          logStreamId: current.id,
          deploymentUrl: url,
          logStreamType: type,
          hmacSecret: secretOf(current),
        };
      }),
      // Streams live on their deployment and go with it.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* onDeployment(
          output.deploymentUrl,
          deployment.deleteIntegration({ id: output.logStreamId }),
        ).pipe(
          Effect.catchTag("LogStreamDoesntExist", () => Effect.void),
          Effect.catchTag(GONE, () => Effect.void),
        );
      }),
    }),
  );
