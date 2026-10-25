import * as advisor from "@distilled.cloud/azure/advisor";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { normalizeScope } from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SuppressionProps {
  /**
   * ARM ID of the resource the recommendation applies to, e.g. a storage
   * account ID, or `/subscriptions/{id}` for a subscription-level
   * recommendation (the recommendation's `resourceMetadata.resourceId`).
   * Changing it replaces the suppression.
   */
  resourceUri: string;
  /**
   * ID (name) of the Advisor recommendation to suppress, as returned by
   * `ListRecommendations` (e.g. a 64-character hex hash). Changing it
   * replaces the suppression.
   */
  recommendationId: string;
  /**
   * Name of the suppression. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the suppression.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * How long the recommendation stays snoozed, as `d.hh:mm:ss` (e.g.
   * `"7.00:00:00"` for a week). Omit it to dismiss the recommendation until
   * the suppression is deleted.
   * @default dismissed with no expiry
   */
  ttl?: string;
}

export interface Suppression extends Resource<
  "Azure.Advisor.Suppression",
  SuppressionProps,
  {
    /** Name of the suppression. */
    name: string;
    /** ARM ID of the resource the recommendation applies to. */
    resourceUri: string;
    /** ID of the suppressed recommendation. */
    recommendationId: string;
    /** ARM resource ID of the suppression. */
    suppressionResourceId: string;
    /** GUID Advisor assigned to the suppression. */
    suppressionId: string | undefined;
    /** Configured snooze duration; `undefined` when dismissed with no expiry. */
    ttl: string | undefined;
    /** Snooze time left as Advisor reports it (it counts down). */
    remainingTtl: string | undefined;
    /**
     * When the snooze ends, from the last write's response (`GetSuppression`
     * spells it `expirationTimestamp`, which the SDK does not decode yet).
     */
    expirationTimeStamp: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Advisor suppression
 * (`Microsoft.Advisor/recommendations/suppressions`) — snoozes an Advisor
 * recommendation for a period (`ttl`) or dismisses it until the suppression
 * is deleted. Deleting the suppression reactivates the recommendation.
 *
 * Advisor generates the recommendations; a suppression targets one by its
 * ID and the ID of the resource it applies to. Suppressions have no tags:
 * a suppression Alchemy did not record in state counts as owned only when
 * it has the name Alchemy generates from the stack, stage and logical ID.
 *
 * Advisor reports the snooze time left (it counts down), so Alchemy
 * re-sends a suppression, restarting the snooze, only when `ttl` changes.
 * Security recommendations belong to Defender for Cloud and cannot be
 * suppressed (`BadRequest: State changes are not allowed for Security
 * category recommendations`).
 *
 * :::caution
 * Changing `resourceUri`, `recommendationId`, or `name` replaces the
 * suppression.
 * :::
 *
 * @see https://learn.microsoft.com/azure/advisor/view-recommendations#dismissing-and-postponing-recommendations
 *
 * ### Snoozing a Recommendation
 * **Example:** Postpone a recommendation for a week
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("data");
 * yield* Azure.Advisor.Suppression("snooze-sku-advice", {
 *   resourceUri: account.storageAccountId,
 *   recommendationId: "08fdb03de251d6ebc72bc6b2d3eb062b34c9eeb301f0ab9ea83b4ceaca4a825b",
 *   ttl: "7.00:00:00",
 * });
 * ```
 *
 * ### Dismissing a Recommendation
 * **Example:** Dismiss a subscription-level recommendation
 * ```typescript
 * const { subscriptionId } = yield* Azure.AzureEnvironment.current;
 * yield* Azure.Advisor.Suppression("dismiss-advice", {
 *   resourceUri: `/subscriptions/${subscriptionId}`,
 *   recommendationId: "08fdb03de251d6ebc72bc6b2d3eb062b34c9eeb301f0ab9ea83b4ceaca4a825b",
 * });
 * ```
 *
 * @resource
 */
export const Suppression = Resource<Suppression>("Azure.Advisor.Suppression");

type ObservedSuppression = advisor.GetSuppressionResponse;

interface Where {
  resourceUri: string;
  recommendationId: string;
  name: string;
}

const getSuppression = (where: Where) => orUndefinedIfNotFound(advisor.GetSuppression(where));

const toAttrs = (
  where: Where,
  observed: ObservedSuppression,
  ttl: string | undefined,
): Suppression["Attributes"] => ({
  name: where.name,
  resourceUri: where.resourceUri,
  recommendationId: where.recommendationId,
  suppressionResourceId:
    observed.id ??
    `${where.resourceUri}/providers/Microsoft.Advisor/recommendations/${where.recommendationId}/suppressions/${where.name}`,
  suppressionId: observed.properties?.suppressionId,
  ttl,
  remainingTtl: observed.properties?.ttl,
  expirationTimeStamp: observed.properties?.expirationTimeStamp,
});

/** Whether Advisor reports a snooze (time left) rather than a dismissal. */
const isSnoozed = (observed: ObservedSuppression) => {
  const ttl = observed.properties?.ttl;
  return ttl !== undefined && ttl !== "" && ttl !== "-1";
};

export const SuppressionProvider = () =>
  Provider.succeed(Suppression, {
    stables: ["name", "resourceUri", "recommendationId", "suppressionResourceId"],

    // Suppressions carry no tags or markers, and a generated name can only
    // be checked against a known logical ID and instance: ownership cannot
    // be proven from a list, so nothing is listed.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Upstream resource IDs are stable attributes; an unresolved one means
      // its resource is being replaced.
      if (!("resourceUri" in news) || !isResolved(news.resourceUri)) {
        return { action: "replace" } as const;
      }
      if (!isResolved<SuppressionProps>(news)) return undefined;
      if (
        normalizeScope(news.resourceUri) !== normalizeScope(output.resourceUri) ||
        news.recommendationId.toLowerCase() !== output.recommendationId.toLowerCase() ||
        (news.name !== undefined && news.name !== output.name)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      const recommendationId = output?.recommendationId ?? olds?.recommendationId;
      if (resourceUri === undefined || recommendationId === undefined) return undefined;
      const generated = yield* createPhysicalName({ id });
      const name = output?.name ?? olds?.name ?? generated;
      const where = { resourceUri, recommendationId, name };
      const observed = yield* getSuppression(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed, output?.ttl ?? olds?.ttl);
      // Recorded in state, or carrying the name generated for this
      // logical ID and instance: ours. Otherwise someone else's.
      return output !== undefined || name === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Advisor");
      const name = news.name ?? output?.name ?? (yield* createPhysicalName({ id }));
      const where = {
        resourceUri: news.resourceUri,
        recommendationId: news.recommendationId,
        name,
      };

      // Observe; the PUT is a synchronous upsert of the whole suppression.
      // Advisor reports the snooze time LEFT as `ttl`, so the configured
      // duration cannot be read back: a PUT (which restarts the snooze) is
      // sent when the suppression is missing, switches between snoozed and
      // dismissed, or its configured `ttl` changed.
      let observed = yield* getSuppression(where);
      if (
        observed === undefined ||
        isSnoozed(observed) !== (news.ttl !== undefined) ||
        (olds !== undefined && olds.ttl !== news.ttl)
      ) {
        observed = yield* advisor.CreateSuppression({
          ...where,
          properties: { ttl: news.ttl },
        });
      }
      return toAttrs(where, observed, news.ttl);
    }),

    delete: Effect.fn(function* ({ output }) {
      const where = {
        resourceUri: output.resourceUri,
        recommendationId: output.recommendationId,
        name: output.name,
      };
      yield* ignoreNotFound(advisor.DeleteSuppression(where));
      yield* waitUntilGone(`advisor suppression ${output.name}`, getSuppression(where));
    }),
  });
