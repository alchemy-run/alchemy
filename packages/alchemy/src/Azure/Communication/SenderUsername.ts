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
import { isEmailServiceOwnedByStack, lower } from "./CommunicationShared.ts";

export interface SenderUsernameProps {
  /** Resource group of the email service. Changing it replaces the sender. */
  resourceGroup: string;
  /** Email service that holds the domain. Changing it replaces the sender. */
  emailService: string;
  /**
   * Email domain the sender belongs to (`EmailDomain.domainName`). Changing
   * it replaces the sender.
   */
  domain: string;
  /**
   * Local part of the sender address (`{username}@{fromSenderDomain}`), e.g.
   * `DoNotReply` or `alerts`. It is also the resource name. Changing it
   * replaces the sender.
   */
  username: string;
  /**
   * Display name recipients see for the sender.
   * @default no display name
   */
  displayName?: string;
}

export interface SenderUsername extends Resource<
  "Azure.Communication.SenderUsername",
  SenderUsernameProps,
  {
    /** Sender username (also the resource name). */
    username: string;
    /** ARM resource ID of the sender username. */
    senderUsernameId: string;
    /** Email domain the sender belongs to. */
    domain: string;
    /** Email service that holds the domain. */
    emailService: string;
    /** Resource group of the email service. */
    resourceGroup: string;
    /** Display name recipients see. */
    displayName: string | undefined;
    /** Geography where the sender's data is stored at rest. */
    dataLocation: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A sender address (the `MailFrom` local part) of an Azure Communication
 * Services email domain.
 *
 * Every domain comes with a `DoNotReply` sender and must keep at least one
 * sender: deleting the last sender is a no-op, and it is removed together
 * with its domain. Sender usernames carry no tags, so ownership follows the
 * parent email service.
 *
 * @see https://learn.microsoft.com/azure/communication-services/quickstarts/email/add-multiple-senders
 *
 * ### Managing Senders
 * **Example:** Set the display name of the default sender
 * ```typescript
 * const sender = yield* Azure.Communication.SenderUsername("sender", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 *   domain: domain.domainName,
 *   username: "DoNotReply",
 *   displayName: "Contoso Notifications",
 * });
 * ```
 *
 * **Example:** Additional sender
 * ```typescript
 * const alerts = yield* Azure.Communication.SenderUsername("alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 *   domain: domain.domainName,
 *   username: "alerts",
 *   displayName: "Contoso Alerts",
 * });
 * ```
 *
 * @resource
 */
export const SenderUsername = Resource<SenderUsername>(
  "Azure.Communication.SenderUsername",
);

const getSender = (
  subscriptionId: string,
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
  senderUsername: string,
) =>
  orUndefinedIfNotFound(
    communication.GetSenderUsername({
      subscriptionId,
      resourceGroupName,
      emailServiceName,
      domainName,
      senderUsername,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  emailService: string,
  domain: string,
  username: string,
  observed: communication.GetSenderUsernameResponse,
): SenderUsername["Attributes"] => ({
  username,
  senderUsernameId: observed.id ?? "",
  domain,
  emailService,
  resourceGroup,
  displayName: observed.properties?.displayName || undefined,
  dataLocation: observed.properties?.dataLocation,
});

export const SenderUsernameProvider = () =>
  Provider.succeed(SenderUsername, {
    stables: [
      "username",
      "senderUsernameId",
      "domain",
      "emailService",
      "resourceGroup",
      "dataLocation",
    ],

    // Senders live inside an email domain; they vanish with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.emailService) !== lower(output.emailService) ||
        lower(news.domain) !== lower(output.domain) ||
        lower(news.username) !== lower(output.username)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const emailService = output?.emailService ?? olds?.emailService;
      const domain = output?.domain ?? olds?.domain;
      const username = output?.username ?? olds?.username;
      if (
        resourceGroup === undefined ||
        emailService === undefined ||
        domain === undefined ||
        username === undefined
      ) {
        return undefined;
      }
      const observed = yield* getSender(
        subscriptionId,
        resourceGroup,
        emailService,
        domain,
        username,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        emailService,
        domain,
        username,
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

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const { resourceGroup, emailService, domain, username } = news;
      const get = getSender(
        subscriptionId,
        resourceGroup,
        emailService,
        domain,
        username,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is synchronous and carries every mutable
      // field, so it is skipped when the observed sender already matches.
      if (
        observed === undefined ||
        (observed.properties?.displayName || undefined) !== news.displayName
      ) {
        observed = yield* communication.SenderUsernamesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          emailServiceName: emailService,
          domainName: domain,
          senderUsername: username,
          properties: { username, displayName: news.displayName ?? "" },
        });
      }

      return toAttrs(resourceGroup, emailService, domain, username, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A domain must keep at least one sender; the last one is removed
      // together with its domain.
      const deleted = yield* ignoreNotFound(
        communication.DeleteSenderUsername({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          emailServiceName: output.emailService,
          domainName: output.domain,
          senderUsername: output.username,
        }),
      ).pipe(
        Effect.as(true),
        Effect.catchTag("SenderUsernameLastRemaining", () =>
          Effect.succeed(false),
        ),
      );
      if (!deleted) return;
      yield* waitUntilGone(
        `sender username ${output.domain}/${output.username}`,
        getSender(
          subscriptionId,
          output.resourceGroup,
          output.emailService,
          output.domain,
          output.username,
        ),
      );
    }),
  });
