import * as pubsub from "@distilled.cloud/stackit/pubsub";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { type ProjectScope, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import {
  ensureListed,
  listsEmail,
  onScope,
  removeListed,
  sameEmail,
  waitForSubscriptionActive,
} from "./internal.ts";

export interface SubscriptionSubscriberAccessProps {
  /** Id of the subscription's topic. Changing it replaces the grant. */
  topicId: string;
  /** Id of the subscription. Changing it replaces the grant. */
  subscriptionId: string;
  /**
   * The subscriber: a user's email address or a service account's. Changing it replaces
   * the grant.
   */
  emailAddress: string;
  /**
   * Project that owns the topic. Defaults to the profile's project. Changing it replaces
   * the grant.
   */
  projectId?: string;
  /**
   * Region of the topic. Defaults to the profile's region. Changing it replaces the
   * grant.
   */
  region?: string;
}

export interface SubscriptionSubscriberAccessAttributes {
  /** Id of the subscription's topic. */
  topicId: string;
  /** Id of the subscription. */
  subscriptionId: string;
  /** The subscriber's address. */
  emailAddress: string;
  /** Project that owns the topic. */
  projectId: string;
  /** Region of the topic. */
  region: string;
}

export type SubscriptionSubscriberAccess = Resource<
  "Stackit.PubSub.SubscriptionSubscriberAccess",
  SubscriptionSubscriberAccessProps,
  SubscriptionSubscriberAccessAttributes,
  never,
  Providers
>;

/**
 * One address on a `Stackit.PubSub.Subscription`'s subscriber list, the list the subscription
 * checks who may pull against. The bindings that pull add one for their host's service
 * account, so you only need this for a subscriber Alchemy doesn't deploy.
 *
 * The list has no ownership marker, so the state is the proof: an address already on the
 * list without state is reported as unowned, and only taken over with `--adopt`.
 *
 * :::caution[Changing `topicId`, `subscriptionId`, `emailAddress`, `projectId` or `region` replaces the Grant]
 * The new address is added and the old one is removed, so the old address loses
 * access.
 * :::
 *
 * ### Granting Access
 * **Example:** Let a service account pull
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * const subscription = yield* Stackit.PubSub.Subscription("Billing", {
 *   topicId: topic.topicId,
 * });
 * const account = yield* Stackit.IAM.ServiceAccount("Invoicer", {});
 * yield* Stackit.PubSub.SubscriptionSubscriberAccess("InvoicerPulls", {
 *   topicId: topic.topicId,
 *   subscriptionId: subscription.subscriptionId,
 *   emailAddress: account.email,
 * });
 * ```
 *
 * ### Removing Access <!-- api-prose -->
 * Destroying the grant removes this one address and keeps the others. The API can only
 * revoke every address at once or replace the list, so it reads the list and writes it
 * back without the address. A write by another client between the two can be lost.
 *
 * @resource
 * @product STACKIT Pub/Sub
 * @category PubSub
 */
export const SubscriptionSubscriberAccess = Resource<SubscriptionSubscriberAccess>(
  "Stackit.PubSub.SubscriptionSubscriberAccess",
);

const subscribers = (scope: ProjectScope, topicId: string, subscriptionId: string) => {
  const place = { ...onScope(scope), topicId, subscriptionId };
  return {
    resource: `the subscribers of STACKIT Pub/Sub subscription ${subscriptionId}`,
    list: pubsub.listSubscriptionSubscribers(place),
    grant: (emailAddress: string) =>
      pubsub.grantSubscriptionSubscriberAccess({ ...place, emailAddress }),
    put: (emailAddresses: Array<string>) =>
      pubsub.updateSubscriptionSubscriberAccess({ ...place, emailAddresses }),
    settled: waitForSubscriptionActive(scope, topicId, subscriptionId),
  };
};

export const SubscriptionSubscriberAccessProvider = () =>
  Provider.succeed(SubscriptionSubscriberAccess, {
    stables: ["topicId", "subscriptionId", "emailAddress", "projectId", "region"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first: the grant is its identity, with no generation marker, and an
      // unresolved prop can resolve to the current one.
      if (
        hasUnresolvedTrigger<SubscriptionSubscriberAccessProps>(news, [
          "topicId",
          "subscriptionId",
          "emailAddress",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<SubscriptionSubscriberAccessProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.topicId !== output.topicId ||
        resolved.subscriptionId !== output.subscriptionId ||
        !sameEmail(resolved.emailAddress, output.emailAddress) ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const topicId = output?.topicId ?? olds?.topicId;
      const subscriptionId = output?.subscriptionId ?? olds?.subscriptionId;
      const emailAddress = output?.emailAddress ?? olds?.emailAddress;
      if (topicId === undefined || subscriptionId === undefined || emailAddress === undefined) {
        return undefined;
      }
      const scope = yield* resolveProjectScope(olds, output);
      const listed = yield* pubsub
        .listSubscriptionSubscribers({ ...onScope(scope), topicId, subscriptionId })
        // No subscription, no grant.
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (listed === undefined || !listsEmail(listed.emailAddresses, emailAddress)) {
        return undefined;
      }
      const attrs: SubscriptionSubscriberAccessAttributes = {
        topicId,
        subscriptionId,
        emailAddress,
        projectId: scope.projectId,
        region: scope.region,
      };
      // No ownership marker exists: a grant is ours when state records it (or it is the
      // generation being replaced). One found without state is someone else's.
      if (output !== undefined) return attrs;
      const isPrevious =
        previous?.topicId === topicId &&
        previous.subscriptionId === subscriptionId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region &&
        sameEmail(previous.emailAddress, emailAddress);
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const { topicId, subscriptionId, emailAddress } = news;
      // Observe, and add when missing. A grant has nothing else to sync.
      yield* ensureListed(subscribers(scope, topicId, subscriptionId), emailAddress);
      return {
        topicId,
        subscriptionId,
        emailAddress,
        projectId: scope.projectId,
        region: scope.region,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* removeListed(
        subscribers(scope, output.topicId, output.subscriptionId),
        output.emailAddress,
      ).pipe(
        // No subscription, no grant.
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
