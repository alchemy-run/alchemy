import * as communication from "@distilled.cloud/azure/communication";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createCommunicationName,
  isEmailServiceOwnedByStack,
  lower,
} from "./CommunicationShared.ts";

export interface SuppressionListProps {
  /** Resource group of the email service. Changing it replaces the list. */
  resourceGroup: string;
  /** Email service that holds the domain. Changing it replaces the list. */
  emailService: string;
  /**
   * Email domain the list belongs to (`EmailDomain.domainName`). Changing it
   * replaces the list.
   */
  domain: string;
  /**
   * Resource name of the suppression list. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * list.
   */
  name?: string;
  /**
   * Sender username the list applies to; must match a sender of the domain,
   * e.g. `DoNotReply`.
   */
  listName: string;
}

export interface SuppressionList extends Resource<
  "Azure.Communication.SuppressionList",
  SuppressionListProps,
  {
    /** Resource name of the suppression list. */
    suppressionListName: string;
    /** ARM resource ID of the suppression list. */
    suppressionListId: string;
    /** Email domain the list belongs to. */
    domain: string;
    /** Email service that holds the domain. */
    emailService: string;
    /** Resource group of the email service. */
    resourceGroup: string;
    /** Sender username the list applies to. */
    listName: string | undefined;
    /** When the list was created. */
    createdTimeStamp: string | undefined;
    /** When the list was last updated. */
    lastUpdatedTimeStamp: string | undefined;
    /** Geography where the list's addresses are stored at rest. */
    dataLocation: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A suppression list of an Azure Communication Services email domain.
 * Email to addresses on the list is not sent from the matching sender.
 *
 * Suppression lists carry no tags, so ownership follows the parent email
 * service. Addresses on the list are data, managed through the API, not
 * this resource.
 *
 * @see https://learn.microsoft.com/azure/communication-services/quickstarts/email/manage-suppression-list-management-sdks
 *
 * ### Creating a Suppression List
 * **Example:** Suppression list for the default sender
 * ```typescript
 * const list = yield* Azure.Communication.SuppressionList("unsubscribed", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 *   domain: domain.domainName,
 *   listName: "DoNotReply",
 * });
 * ```
 *
 * @resource
 */
export const SuppressionList = Resource<SuppressionList>(
  "Azure.Communication.SuppressionList",
);

const getList = (
  subscriptionId: string,
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
  suppressionListName: string,
) =>
  orUndefinedIfNotFound(
    communication.GetSuppressionList({
      subscriptionId,
      resourceGroupName,
      emailServiceName,
      domainName,
      suppressionListName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  emailService: string,
  domain: string,
  name: string,
  observed: communication.GetSuppressionListResponse,
): SuppressionList["Attributes"] => ({
  suppressionListName: name,
  suppressionListId: observed.id ?? "",
  domain,
  emailService,
  resourceGroup,
  listName: observed.properties?.listName,
  createdTimeStamp: observed.properties?.createdTimeStamp,
  lastUpdatedTimeStamp: observed.properties?.lastUpdatedTimeStamp,
  dataLocation: observed.properties?.dataLocation,
});

export const SuppressionListProvider = () =>
  Provider.succeed(SuppressionList, {
    stables: [
      "suppressionListName",
      "suppressionListId",
      "domain",
      "emailService",
      "resourceGroup",
      "createdTimeStamp",
      "dataLocation",
    ],

    // Suppression lists live inside an email domain; they vanish with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.emailService) !== lower(output.emailService) ||
        lower(news.domain) !== lower(output.domain) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.suppressionListName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const emailService = output?.emailService ?? olds?.emailService;
      const domain = output?.domain ?? olds?.domain;
      if (
        resourceGroup === undefined ||
        emailService === undefined ||
        domain === undefined
      ) {
        return undefined;
      }
      const name =
        output?.suppressionListName ??
        olds?.name ??
        (yield* createCommunicationName(id));
      const observed = yield* getList(
        subscriptionId,
        resourceGroup,
        emailService,
        domain,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        emailService,
        domain,
        name,
        observed,
      );
      // No tags: ownership follows the parent email service.
      const owned = yield* isEmailServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        emailService,
      );
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const { resourceGroup, emailService, domain } = news;
      const name =
        news.name ??
        output?.suppressionListName ??
        (yield* createCommunicationName(id));

      // Observe.
      let observed = yield* getList(
        subscriptionId,
        resourceGroup,
        emailService,
        domain,
        name,
      );

      // Ensure + sync. The PUT is synchronous and carries the only mutable
      // field, so it is skipped when the observed list already matches.
      if (
        observed === undefined ||
        lower(observed.properties?.listName) !== lower(news.listName)
      ) {
        observed = yield* communication.SuppressionListsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          emailServiceName: emailService,
          domainName: domain,
          suppressionListName: name,
          properties: { listName: news.listName },
        });
      }

      return toAttrs(resourceGroup, emailService, domain, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        communication.DeleteSuppressionList({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          emailServiceName: output.emailService,
          domainName: output.domain,
          suppressionListName: output.suppressionListName,
        }),
      );
      yield* waitUntilGone(
        `suppression list ${output.domain}/${output.suppressionListName}`,
        getList(
          subscriptionId,
          output.resourceGroup,
          output.emailService,
          output.domain,
          output.suppressionListName,
        ),
      );
    }),
  });
