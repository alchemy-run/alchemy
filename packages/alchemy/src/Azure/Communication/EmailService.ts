import * as communication from "@distilled.cloud/azure/communication";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createCommunicationName,
  DEFAULT_DATA_LOCATION,
  GLOBAL_LOCATION,
  lower,
} from "./CommunicationShared.ts";

export interface EmailServiceProps {
  /**
   * Resource group the email service is created in. Changing it replaces
   * the email service.
   */
  resourceGroup: string;
  /**
   * Email service name: 1-63 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the email service.
   */
  name?: string;
  /**
   * ARM location. Email services are global resources. Changing it replaces
   * the email service.
   * @default "global"
   */
  location?: string;
  /**
   * Geography where email data is stored at rest, e.g. `United States`,
   * `Europe`, `UK`, `Australia`, `Japan`. Changing it replaces the email
   * service.
   * @default "United States"
   */
  dataLocation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EmailService extends Resource<
  "Azure.Communication.EmailService",
  EmailServiceProps,
  {
    /** Name of the email service. */
    emailServiceName: string;
    /** ARM resource ID of the email service. */
    emailServiceId: string;
    /** Resource group that holds the email service. */
    resourceGroup: string;
    /** ARM location of the email service (`global`). */
    location: string;
    /** Geography where email data is stored at rest. */
    dataLocation: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Communication Services email service — the container for the
 * sender domains used to send email through a communication service.
 *
 * @see https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview
 *
 * ### Creating an Email Service
 * **Example:** Email service in the United States
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const email = yield* Azure.Communication.EmailService("email", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Email service with data stored in Europe
 * ```typescript
 * const email = yield* Azure.Communication.EmailService("email", {
 *   resourceGroup: group.resourceGroupName,
 *   dataLocation: "Europe",
 *   tags: { team: "growth" },
 * });
 * ```
 *
 * @resource
 */
export const EmailService = Resource<EmailService>(
  "Azure.Communication.EmailService",
);

type ObservedEmailService = communication.GetEmailServiceResponse;

const getEmailService = (
  subscriptionId: string,
  resourceGroupName: string,
  emailServiceName: string,
) =>
  orUndefinedIfNotFound(
    communication.GetEmailService({
      subscriptionId,
      resourceGroupName,
      emailServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedEmailService,
): EmailService["Attributes"] => ({
  emailServiceName: name,
  emailServiceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  dataLocation: observed.properties?.dataLocation ?? "",
  tags: userTags(observed.tags),
});

export const EmailServiceProvider = () =>
  Provider.succeed(EmailService, {
    stables: [
      "emailServiceName",
      "emailServiceId",
      "resourceGroup",
      "location",
      "dataLocation",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* communication
        .ListEmailServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListEmailServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.emailServiceName)) ||
        lower(news.location ?? GLOBAL_LOCATION) !== lower(output.location) ||
        lower(news.dataLocation ?? DEFAULT_DATA_LOCATION) !==
          lower(output.dataLocation)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.emailServiceName ??
        olds?.name ??
        (yield* createCommunicationName(id));
      const observed = yield* getEmailService(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.emailServiceName ??
        (yield* createCommunicationName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        emailServiceName: name,
      };
      const get = getEmailService(subscriptionId, resourceGroup, name);
      const label = `email service ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* communication.EmailServicesCreateOrUpdate({
          ...where,
          location: news.location ?? GLOBAL_LOCATION,
          tags,
          properties: {
            dataLocation: news.dataLocation ?? DEFAULT_DATA_LOCATION,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => service.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* communication.UpdateEmailService({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) => service.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        communication.DeleteEmailService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          emailServiceName: output.emailServiceName,
        }),
      );
      yield* waitUntilGone(
        `email service ${output.emailServiceName}`,
        getEmailService(
          subscriptionId,
          output.resourceGroup,
          output.emailServiceName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
