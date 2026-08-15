import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { sanitizeKey } from "../../RuntimeContext.ts";
import { ambientOidcToken } from "./OidcToken.ts";
import { MissingDeploymentId, type OidcTokenError } from "./QueueTypes.ts";
import type { Topic } from "./Topic.ts";

/**
 * Shared client scaffolding for the queue capabilities: token and
 * deployment-pin resolution, plus the env refs the deploy-time binding
 * halves inject.
 *
 * INTERNAL — NOT exported from the Vercel `index.ts` (see the
 * Read/Write/ReadWrite binding convention on shared scaffolding).
 */

export interface QueueClientOptions {
  /**
   * OIDC bearer token. Defaults to the ambient token (request-context
   * header / `VERCEL_OIDC_TOKEN`). Pass a plain `Redacted` for a one-shot
   * token (e.g. from `mintProjectOidcToken`) or an Effect for a refreshing
   * accessor (e.g. from `projectOidcToken`).
   */
  readonly token?:
    | Redacted.Redacted<string>
    | Effect.Effect<Redacted.Redacted<string>, OidcTokenError>;
  /**
   * Deployment partition pin. `undefined` follows the topic's `partition`
   * mode (pinning from the ambient `VERCEL_DEPLOYMENT_ID` when
   * `"deployment"`); a string pins explicitly; `null` opts out (the shared
   * partition), overriding the topic.
   */
  readonly deploymentId?: string | null;
}

/** Resolve the effective bearer token per {@link QueueClientOptions.token}. */
export const resolveQueueToken = (
  token: QueueClientOptions["token"],
): Effect.Effect<Redacted.Redacted<string>, OidcTokenError> =>
  token === undefined
    ? ambientOidcToken
    : Redacted.isRedacted(token)
      ? Effect.succeed(token)
      : token;

/**
 * Resolve the effective `Vqs-Deployment-Id` pin. Deployment pinning is
 * load-bearing (live-verified): unpinned sends are invisible to pinned
 * receivers and vice versa, so a `"deployment"`-partitioned topic with no
 * resolvable deployment id is a typed failure, not a silent unpin.
 */
export const resolveQueueDeploymentId = (
  topic: Topic,
  deploymentId: QueueClientOptions["deploymentId"],
): Effect.Effect<string | undefined, MissingDeploymentId> =>
  Effect.suspend(() => {
    if (deploymentId === null) return Effect.succeed(undefined);
    if (deploymentId !== undefined) return Effect.succeed(deploymentId);
    if (topic.partition === "shared") return Effect.succeed(undefined);
    const ambient = process.env.VERCEL_DEPLOYMENT_ID;
    if (ambient !== undefined && ambient !== "") {
      return Effect.succeed(ambient);
    }
    return Effect.fail(
      new MissingDeploymentId({
        message:
          `Topic '${topic.topicName}' partitions by deployment but no deployment id is available ` +
          "(VERCEL_DEPLOYMENT_ID is not set). Pass `deploymentId` explicitly, or `deploymentId: null` " +
          '(or declare the topic with `partition: "shared"`) to use the shared partition.',
        topic: topic.topicName,
      }),
    );
  });

/** Env var name a queue binding injects for a topic (async-mode visibility). */
export const topicEnvKey = (topic: Topic): string =>
  `VERCEL_QUEUE_${sanitizeKey(topic.topicName).toUpperCase()}`;

/** Env var value: the topic's static config (never tokens — OIDC is ambient). */
export const topicEnvValue = (topic: Topic): string =>
  JSON.stringify({
    topic: topic.topicName,
    region: topic.region,
    partition: topic.partition,
  });
