import * as trafficmanager from "@distilled.cloud/azure/trafficmanager";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** The key takes no settings: Azure generates it. */
export interface UserMetricsKeyProps {}

export interface UserMetricsKey extends Resource<
  "Azure.TrafficManager.UserMetricsKey",
  UserMetricsKeyProps,
  {
    /** ARM resource ID of the key (`.../trafficManagerUserMetricsKeys/default`). */
    userMetricsKeyId: string;
    /** The Real User Metrics key that the measurement JavaScript sends with each report. */
    key: Redacted.Redacted<string>;
  },
  never,
  Providers
> {}

/**
 * The Traffic Manager Real User Metrics key of the subscription
 * (`Microsoft.Network/trafficManagerUserMetricsKeys`). Real User
 * Measurements send latency from end-user browsers or apps to Traffic
 * Manager, which uses them to improve `Performance` routing. The key
 * identifies the subscription in those reports.
 *
 * Each subscription has one key, named `default`. Azure generates the
 * value; Alchemy creates it if it is missing and never regenerates an
 * existing key.
 *
 * :::caution
 * The key is a subscription-wide singleton without tags, so Alchemy cannot
 * mark it as its own. A key that already exists is adopted only with
 * `--adopt`, and destroying the resource deletes the subscription's key.
 * :::
 *
 * @see https://learn.microsoft.com/azure/traffic-manager/traffic-manager-rum-overview
 *
 * ### Creating the Key
 * **Example:** Real User Metrics key for the subscription
 * ```typescript
 * const rum = yield* Azure.TrafficManager.UserMetricsKey("rum", {});
 * // embed Redacted.value(rum.key) in the measurement script
 * ```
 *
 * @resource
 */
export const UserMetricsKey = Resource<UserMetricsKey>("Azure.TrafficManager.UserMetricsKey");

type ObservedKey = trafficmanager.GetTrafficManagerUserMetricsKeyResponse;

const keyId = (subscriptionId: string) =>
  `/subscriptions/${subscriptionId}/providers/Microsoft.Network/trafficManagerUserMetricsKeys/default`;

const getKey = (subscriptionId: string) =>
  orUndefinedIfNotFound(trafficmanager.GetTrafficManagerUserMetricsKey({ subscriptionId }));

/** Whether the GET returned a key (Azure answers an empty body when there is none). */
const hasKey = (observed: ObservedKey | undefined): observed is ObservedKey =>
  observed?.properties?.key !== undefined && observed.properties.key !== "";

const toAttrs = (subscriptionId: string, observed: ObservedKey): UserMetricsKey["Attributes"] => ({
  userMetricsKeyId: observed.id ?? keyId(subscriptionId),
  key: Redacted.make(observed.properties?.key ?? ""),
});

export const UserMetricsKeyProvider = () =>
  Provider.succeed(UserMetricsKey, {
    stables: ["userMetricsKeyId"],

    // The key carries no ownership marker, so nuke must not delete it.
    list: Effect.fn(function* () {
      return [];
    }),

    read: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getKey(subscriptionId);
      if (!hasKey(observed)) return undefined;
      const attrs = toAttrs(subscriptionId, observed);
      // Without state, an existing key may belong to someone else.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");

      // Observe.
      const observed = yield* getKey(subscriptionId);
      if (hasKey(observed)) return toAttrs(subscriptionId, observed);

      // Ensure: the PUT generates a new key, so it only runs when none exists.
      const created = yield* trafficmanager.TrafficManagerUserMetricsKeysCreateOrUpdate({
        subscriptionId,
      });
      return toAttrs(subscriptionId, created);
    }),

    delete: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(trafficmanager.DeleteTrafficManagerUserMetricsKey({ subscriptionId }));
      yield* waitUntilGone(
        "traffic manager user metrics key",
        getKey(subscriptionId).pipe(
          Effect.map((observed) => (hasKey(observed) ? observed : undefined)),
        ),
      );
    }),
  });
