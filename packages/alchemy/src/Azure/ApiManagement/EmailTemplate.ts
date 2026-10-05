import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export type EmailTemplateName =
  apim.EmailTemplateCreateOrUpdateRequestTemplateName;

export interface EmailTemplateProps {
  /** Resource group of the API Management service. Changing it replaces the template. */
  resourceGroup: string;
  /** API Management service that sends the email. Changing it replaces the template. */
  serviceName: string;
  /**
   * Which built-in notification email to customize, e.g.
   * `applicationApprovedNotificationMessage`. Changing it replaces the
   * template.
   */
  templateName: EmailTemplateName;
  /** Email subject (may use `$parameter` placeholders). */
  subject: string;
  /** Email body as an HTML/XSLT document (may use `$parameter` placeholders). */
  body: string;
  /** Title of the template. */
  title?: string;
  /** Description of the template. */
  description?: string;
}

export interface EmailTemplate extends Resource<
  "Azure.ApiManagement.EmailTemplate",
  EmailTemplateProps,
  {
    /** Built-in template name. */
    templateName: string;
    /** ARM resource ID of the template. */
    emailTemplateId: string;
    /** API Management service that sends the email. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Email subject. */
    subject: string;
  },
  never,
  Providers
> {}

/**
 * Customizes one of the built-in notification emails an API Management
 * service sends to developers (sign-up confirmation, subscription
 * approved, ...). Every template always exists; deleting the resource
 * restores Azure's default content. Not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-configure-notifications
 *
 * ### Customizing Emails
 * **Example:** Brand the subscription-approved email
 * ```typescript
 * yield* Azure.ApiManagement.EmailTemplate("approved", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   templateName: "applicationApprovedNotificationMessage",
 *   subject: "Your $OrganizationName subscription is ready",
 *   body: approvedEmailBody,
 * });
 * ```
 *
 * @resource
 */
export const EmailTemplate = Resource<EmailTemplate>(
  "Azure.ApiManagement.EmailTemplate",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  templateName: string;
}

export const EmailTemplateProvider = () =>
  Provider.succeed(EmailTemplate, {
    stables: [
      "templateName",
      "emailTemplateId",
      "serviceName",
      "resourceGroup",
    ],
    // Templates always exist; nuke has nothing to delete.
    nuke: { singleton: true },
    ...entityLifecycle<
      EmailTemplateProps,
      EmailTemplate["Attributes"],
      Key,
      apim.GetEmailTemplateResponse
    >({
      label: (key) => `API Management email template ${key.templateName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          templateName: props.templateName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetEmailTemplate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          templateName: key.templateName,
        }),
      put: (subscriptionId, key, news) =>
        apim.EmailTemplateCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          templateName: key.templateName,
          properties: {
            subject: news.subject,
            body: news.body,
            title: news.title,
            description: news.description,
          },
        }).pipe(
          // Template writes share a per-subscription throttle
          // (`PerSubEmailTemplateWrites`); wait for the window to reopen.
          Effect.retry({
            while: (e) => e._tag === "RequestRateLimitExceeded",
            schedule: Schedule.spaced("20 seconds"),
            times: 6,
          }),
        ),
      // Deleting a template resets it to the default content.
      remove: (subscriptionId, key) =>
        apim
          .DeleteEmailTemplate({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            templateName: key.templateName,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "RequestRateLimitExceeded",
              schedule: Schedule.spaced("20 seconds"),
              times: 6,
            }),
          ),
      resetOnDelete: true,
      inSync: (news, observed) =>
        observed.properties?.isDefault === false &&
        observed.properties.subject === news.subject &&
        observed.properties.body === news.body &&
        (news.title === undefined ||
          observed.properties.title === news.title) &&
        (news.description === undefined ||
          observed.properties.description === news.description),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        templateName: key.templateName,
        emailTemplateId: observed.id ?? "",
        subject: observed.properties?.subject ?? "",
      }),
    }),
  });
