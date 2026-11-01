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
  waitForTopicActive,
} from "./internal.ts";

export interface TopicPublisherAccessProps {
  /** Id of the topic. Changing it replaces the grant. */
  topicId: string;
  /**
   * The publisher: a user's email address or a service account's. Changing it replaces
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

export interface TopicPublisherAccessAttributes {
  /** Id of the topic. */
  topicId: string;
  /** The publisher's address. */
  emailAddress: string;
  /** Project that owns the topic. */
  projectId: string;
  /** Region of the topic. */
  region: string;
}

export type TopicPublisherAccess = Resource<
  "Stackit.PubSub.TopicPublisherAccess",
  TopicPublisherAccessProps,
  TopicPublisherAccessAttributes,
  never,
  Providers
>;

/**
 * One address on a `Stackit.PubSub.Topic`'s publisher list, the list the topic checks who
 * may publish against. The bindings that publish add one for their host's service account,
 * so you only need this for a publisher Alchemy doesn't deploy.
 *
 * The list has no ownership marker, so the state is the proof: an address already on the
 * list without state is reported as unowned, and only taken over with `--adopt`.
 *
 * ### Granting Access
 * **Example:** Let a service account publish
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * const account = yield* Stackit.IAM.ServiceAccount("Shop", {});
 * yield* Stackit.PubSub.TopicPublisherAccess("ShopPublishes", {
 *   topicId: topic.topicId,
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
export const TopicPublisherAccess = Resource<TopicPublisherAccess>(
  "Stackit.PubSub.TopicPublisherAccess",
);

const publishers = (scope: ProjectScope, topicId: string) => {
  const place = { ...onScope(scope), topicId };
  return {
    resource: `the publishers of STACKIT Pub/Sub topic ${topicId}`,
    list: pubsub.listTopicPublishers(place),
    grant: (emailAddress: string) => pubsub.grantTopicPublisherAccess({ ...place, emailAddress }),
    put: (emailAddresses: Array<string>) =>
      pubsub.updatePublisherAccess({ ...place, emailAddresses }),
    settled: waitForTopicActive(scope, topicId),
  };
};

export const TopicPublisherAccessProvider = () =>
  Provider.succeed(TopicPublisherAccess, {
    stables: ["topicId", "emailAddress", "projectId", "region"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first: the grant is its identity, with no generation marker, and an
      // unresolved prop can resolve to the current one.
      if (
        hasUnresolvedTrigger<TopicPublisherAccessProps>(news, [
          "topicId",
          "emailAddress",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<TopicPublisherAccessProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.topicId !== output.topicId ||
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
      const emailAddress = output?.emailAddress ?? olds?.emailAddress;
      if (topicId === undefined || emailAddress === undefined) return undefined;
      const scope = yield* resolveProjectScope(olds, output);
      const listed = yield* pubsub
        .listTopicPublishers({ ...onScope(scope), topicId })
        // No topic, no grant.
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (listed === undefined || !listsEmail(listed.emailAddresses, emailAddress)) {
        return undefined;
      }
      const attrs: TopicPublisherAccessAttributes = {
        topicId,
        emailAddress,
        projectId: scope.projectId,
        region: scope.region,
      };
      // No ownership marker exists: a grant is ours when state records it (or it is the
      // generation being replaced). One found without state is someone else's.
      if (output !== undefined) return attrs;
      const isPrevious =
        previous?.topicId === topicId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region &&
        sameEmail(previous.emailAddress, emailAddress);
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const { topicId, emailAddress } = news;
      // Observe, and add when missing. A grant has nothing else to sync.
      yield* ensureListed(publishers(scope, topicId), emailAddress);
      return { topicId, emailAddress, projectId: scope.projectId, region: scope.region };
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* removeListed(publishers(scope, output.topicId), output.emailAddress).pipe(
        // No topic, no grant.
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
