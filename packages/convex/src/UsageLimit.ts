import * as deployment from "@distilled.cloud/convex/deployment";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { DeploymentAttributes } from "./Deployment.ts";
import { GONE, onDeployment } from "./internal/deployment.ts";
import { createOnce } from "./internal/retry.ts";
import type { Providers } from "./Providers.ts";

export interface UsageLimitProps {
  /** The deployment to limit. Changing it replaces the limit. */
  deployment: Pick<DeploymentAttributes, "url">;
  /** What to measure, such as `functionCalls` or `databaseIoGb`. */
  metric: string;
  /** The calendar-aligned window the limit covers: `day` or `month`. */
  window: "day" | "month";
  /** `warning` notifies you, and `disable` pauses the deployment when the limit is hit. */
  limitType: "warning" | "disable";
  /** The limit, in the metric's unit. Must be at least 1. */
  limit: number;
  /**
   * Whether the limit applies.
   * @default true
   */
  enabled?: boolean;
}

export interface UsageLimitAttributes {
  /** The limit's ID. */
  usageLimitId: string;
  /** The URL of the deployment this limit applies to. */
  deploymentUrl: string;
  /** What is measured. */
  metric: string;
  /** The window the limit covers. */
  window: string;
  /** What happens at the limit. */
  limitType: string;
  /** The limit, in the metric's unit. */
  limit: number;
  /** Whether the limit applies. */
  enabled: boolean;
}

export type UsageLimit = Resource<
  "Convex.UsageLimit",
  UsageLimitProps,
  UsageLimitAttributes,
  never,
  Providers
>;

/**
 * A usage limit on a Convex deployment. A `disable` limit pauses the
 * deployment when it is reached.
 *
 * Convex allows one limit per metric, window and type on a deployment.
 *
 * ### Creating a Limit
 * **Example:** Warn at a million function calls a month
 * ```typescript
 * yield* Convex.UsageLimit("Calls", {
 *   deployment,
 *   metric: "functionCalls",
 *   window: "month",
 *   limitType: "warning",
 *   limit: 1_000_000,
 * });
 * ```
 *
 * @see https://docs.convex.dev/deployment-api/create-usage-limit
 *
 * @resource
 * @product Deployment
 */
export const UsageLimit = Resource<UsageLimit>("Convex.UsageLimit");

const toAttrs = (
  deploymentUrl: string,
  item: deployment.UsageLimitConfigResponse,
): UsageLimitAttributes => ({
  usageLimitId: item.id,
  deploymentUrl,
  metric: item.metric,
  window: item.window,
  limitType: item.limitType,
  limit: item.limit,
  enabled: item.enabled,
});

const list = (url: string) =>
  onDeployment(url, deployment.listUsageLimits({})).pipe(Effect.map((r) => r.usageLimits));

const matches = (props: UsageLimitProps) => (item: deployment.UsageLimitConfigResponse) =>
  item.metric === props.metric &&
  item.window === props.window &&
  item.limitType === props.limitType;

export const UsageLimitProvider = () =>
  Provider.effect(
    UsageLimit,
    Effect.succeed({
      stables: ["usageLimitId", "deploymentUrl"],
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news)) return undefined;
        if (output !== undefined && news.deployment.url !== output.deploymentUrl) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const url = output?.deploymentUrl ?? olds?.deployment.url;
        if (url === undefined) return undefined;
        const items = yield* list(url);
        if (output !== undefined) {
          const item = items.find((candidate) => candidate.id === output.usageLimitId);
          return item && toAttrs(url, item);
        }
        const item = olds && items.find(matches(olds));
        return item && Unowned(toAttrs(url, item));
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const url = news.deployment.url;
        const desired = {
          metric: news.metric,
          window: news.window,
          limitType: news.limitType,
          limit: news.limit,
          enabled: news.enabled ?? true,
        };

        // Observe
        const items = yield* list(url);
        const current =
          items.find((item) => item.id === output?.usageLimitId) ?? items.find(matches(news));

        // Ensure
        if (current === undefined) {
          yield* session.note(`Creating ${news.metric} limit...`);
          const { usageLimit } = yield* onDeployment(
            url,
            createOnce(deployment.createUsageLimit(desired)),
          );
          return toAttrs(url, usageLimit);
        }

        // Sync
        const unchanged =
          matches(news)(current) &&
          current.limit === desired.limit &&
          current.enabled === desired.enabled;
        if (unchanged) return toAttrs(url, current);
        yield* session.note(`Updating ${news.metric} limit...`);
        const { usageLimit } = yield* onDeployment(
          url,
          deployment.updateUsageLimit({ id: current.id, ...desired }),
        );
        return toAttrs(url, usageLimit);
      }),
      // Limits live on their deployment and go with it.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* onDeployment(
          output.deploymentUrl,
          deployment.deleteUsageLimit({ id: output.usageLimitId }),
        ).pipe(
          Effect.catchTag("UsageLimitNotFound", () => Effect.void),
          Effect.catchTag(GONE, () => Effect.void),
        );
      }),
    }),
  );
