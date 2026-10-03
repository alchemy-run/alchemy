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
  isCommunicationServiceOwnedByStack,
  lower,
} from "./CommunicationShared.ts";

export interface SmtpUsernameProps {
  /**
   * Resource group of the communication service. Changing it replaces the
   * SMTP username.
   */
  resourceGroup: string;
  /**
   * Communication service the SMTP username authenticates against. Changing
   * it replaces the SMTP username.
   */
  communicationService: string;
  /**
   * Resource name of the SMTP username. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * SMTP username.
   */
  name?: string;
  /**
   * Username SMTP clients log in with: free form or an email address.
   * Azure does not allow changing it, so changing it replaces the SMTP
   * username.
   */
  username: string;
  /**
   * Application (client) ID of the Entra ID app whose client secret is the
   * SMTP password. The app needs a role on the communication service that
   * allows sending email.
   */
  entraApplicationId: string;
  /**
   * Entra tenant of the application.
   * @default the subscription's tenant
   */
  tenantId?: string;
}

export interface SmtpUsername extends Resource<
  "Azure.Communication.SmtpUsername",
  SmtpUsernameProps,
  {
    /** Resource name of the SMTP username. */
    smtpUsernameName: string;
    /** ARM resource ID of the SMTP username. */
    smtpUsernameId: string;
    /** Communication service the username belongs to. */
    communicationService: string;
    /** Resource group of the communication service. */
    resourceGroup: string;
    /** Username SMTP clients log in with. */
    username: string;
    /** Application ID of the linked Entra ID app. */
    entraApplicationId: string;
    /** Tenant of the linked Entra ID app. */
    tenantId: string;
  },
  never,
  Providers
> {}

/**
 * An SMTP username of an Azure Communication Services resource. SMTP
 * clients authenticate to `smtp.azurecomm.net` with this username and the
 * client secret of the linked Entra ID application.
 *
 * SMTP usernames carry no tags, so ownership follows the parent
 * communication service.
 *
 * @see https://learn.microsoft.com/azure/communication-services/quickstarts/email/send-email-smtp/smtp-authentication
 *
 * ### Creating an SMTP Username
 * **Example:** SMTP login backed by an Entra ID app
 * ```typescript
 * const smtp = yield* Azure.Communication.SmtpUsername("smtp", {
 *   resourceGroup: group.resourceGroupName,
 *   communicationService: acs.communicationServiceName,
 *   username: "mailer@contoso.com",
 *   entraApplicationId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const SmtpUsername = Resource<SmtpUsername>(
  "Azure.Communication.SmtpUsername",
);

const getSmtp = (
  subscriptionId: string,
  resourceGroupName: string,
  communicationServiceName: string,
  smtpUsername: string,
) =>
  orUndefinedIfNotFound(
    communication.GetSmtpUsername({
      subscriptionId,
      resourceGroupName,
      communicationServiceName,
      smtpUsername,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  communicationService: string,
  name: string,
  observed: communication.GetSmtpUsernameResponse,
): SmtpUsername["Attributes"] => ({
  smtpUsernameName: name,
  smtpUsernameId: observed.id ?? "",
  communicationService,
  resourceGroup,
  username: observed.properties?.username ?? "",
  entraApplicationId: observed.properties?.entraApplicationId ?? "",
  tenantId: observed.properties?.tenantId ?? "",
});

export const SmtpUsernameProvider = () =>
  Provider.succeed(SmtpUsername, {
    stables: [
      "smtpUsernameName",
      "smtpUsernameId",
      "communicationService",
      "resourceGroup",
      "username",
    ],

    // SMTP usernames live inside a communication service; they vanish with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.communicationService) !==
          lower(output.communicationService) ||
        news.username !== output.username ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.smtpUsernameName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const communicationService =
        output?.communicationService ?? olds?.communicationService;
      if (resourceGroup === undefined || communicationService === undefined) {
        return undefined;
      }
      const name =
        output?.smtpUsernameName ??
        olds?.name ??
        (yield* createCommunicationName(id));
      const observed = yield* getSmtp(
        subscriptionId,
        resourceGroup,
        communicationService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        communicationService,
        name,
        observed,
      );
      // No tags: ownership follows the parent communication service.
      const owned = yield* isCommunicationServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        communicationService,
      );
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const { resourceGroup, communicationService } = news;
      const name =
        news.name ??
        output?.smtpUsernameName ??
        (yield* createCommunicationName(id));
      const desired = {
        username: news.username,
        entraApplicationId: news.entraApplicationId,
        tenantId: news.tenantId ?? env.tenantId,
      };

      // Observe.
      let observed = yield* getSmtp(
        subscriptionId,
        resourceGroup,
        communicationService,
        name,
      );

      // Ensure + sync. The PUT is synchronous and carries every field, so it
      // is skipped when the observed Entra app already matches (the username
      // itself is immutable; diff replaces on change).
      const props = observed?.properties;
      if (
        props === undefined ||
        lower(props.entraApplicationId) !== lower(desired.entraApplicationId) ||
        lower(props.tenantId) !== lower(desired.tenantId)
      ) {
        observed = yield* communication.SmtpUsernamesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          communicationServiceName: communicationService,
          smtpUsername: name,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, communicationService, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        communication.DeleteSmtpUsername({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          communicationServiceName: output.communicationService,
          smtpUsername: output.smtpUsernameName,
        }),
      );
      yield* waitUntilGone(
        `smtp username ${output.communicationService}/${output.smtpUsernameName}`,
        getSmtp(
          subscriptionId,
          output.resourceGroup,
          output.communicationService,
          output.smtpUsernameName,
        ),
      );
    }),
  });
