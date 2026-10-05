import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, sameName } from "./common.ts";

export interface DomainTopicProps {
  /** Resource group of the domain. Changing it replaces the domain topic. */
  resourceGroup: string;
  /** Name of the parent Event Grid domain. Changing it replaces the domain topic. */
  domain: string;
  /**
   * Domain topic name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the domain topic.
   */
  name?: string;
}

export interface DomainTopic extends Resource<
  "Azure.EventGrid.DomainTopic",
  DomainTopicProps,
  {
    /** Name of the domain topic. */
    domainTopicName: string;
    /** ARM resource ID of the domain topic; use it as an event-subscription scope. */
    domainTopicId: string;
    /** Name of the parent domain. */
    domain: string;
    /** Resource group of the parent domain. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A topic inside an Event Grid domain. Events published to the domain
 * endpoint with `topic` set to this name are routed to its subscriptions.
 *
 * Domain topics have no tags; ownership follows the parent domain. If the
 * domain has `autoDeleteTopicWithLastSubscription` enabled, Azure deletes
 * the topic when its last subscription is removed.
 *
 * @see https://learn.microsoft.com/azure/event-grid/event-domains
 *
 * ### Creating a Domain Topic
 * **Example:** One topic per tenant
 * ```typescript
 * const domain = yield* Azure.EventGrid.Domain("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const contoso = yield* Azure.EventGrid.DomainTopic("contoso", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 *   name: "contoso",
 * });
 * ```
 *
 * @resource
 */
export const DomainTopic = Resource<DomainTopic>("Azure.EventGrid.DomainTopic");

const getDomainTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
  domainTopicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetDomainTopic({
      subscriptionId,
      resourceGroupName,
      domainName,
      domainTopicName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  domain: string,
  name: string,
  topic: { id?: string },
): DomainTopic["Attributes"] => ({
  domainTopicName: name,
  domainTopicId: topic.id ?? "",
  domain,
  resourceGroup,
});

export const DomainTopicProvider = () =>
  Provider.succeed(DomainTopic, {
    stables: ["domainTopicName", "domainTopicId", "domain", "resourceGroup"],

    // Domain topics are deleted with their domain.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.domain, output.domain) ||
        (news.name !== undefined && news.name !== output.domainTopicName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Domain topics carry no tags; ownership follows the parent domain.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const domain = output?.domain ?? olds?.domain;
      if (resourceGroup === undefined || domain === undefined) {
        return undefined;
      }
      const name =
        output?.domainTopicName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getDomainTopic(
        subscriptionId,
        resourceGroup,
        domain,
        name,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, domain, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, domain } = news;
      const name =
        news.name ??
        output?.domainTopicName ??
        (yield* createEventGridName(id, 50));
      const get = getDomainTopic(subscriptionId, resourceGroup, domain, name);

      // Observe, then ensure. A domain topic has no mutable properties.
      const observed = yield* get;
      if (observed === undefined) {
        yield* eventgrid.DomainTopicsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          domainName: domain,
          domainTopicName: name,
        });
      }
      const fresh = yield* waitForProvisioned(
        `event grid domain topic ${name}`,
        get,
        (topic) => topic.properties?.provisioningState,
        { times: 60 },
      );
      return toAttrs(resourceGroup, domain, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteDomainTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domain,
          domainTopicName: output.domainTopicName,
        }),
      );
      yield* waitUntilGone(
        `event grid domain topic ${output.domainTopicName}`,
        getDomainTopic(
          subscriptionId,
          output.resourceGroup,
          output.domain,
          output.domainTopicName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Domain"] },
  });
