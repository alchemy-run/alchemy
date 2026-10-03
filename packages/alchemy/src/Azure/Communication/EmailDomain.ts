import * as communication from "@distilled.cloud/azure/communication";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GLOBAL_LOCATION, lower } from "./CommunicationShared.ts";

export type EmailDomainManagement = communication.DomainManagement;
export type EmailUserEngagementTracking = communication.UserEngagementTracking;

/** The fixed name Azure requires for an Azure-managed domain. */
export const AZURE_MANAGED_DOMAIN_NAME = "AzureManagedDomain";

export class EmailDomainNameRequired extends Data.TaggedError(
  "Azure.Communication.EmailDomainNameRequired",
)<{ readonly message: string }> {}

export interface EmailDomainProps {
  /** Resource group of the email service. Changing it replaces the domain. */
  resourceGroup: string;
  /** Email service that holds the domain. Changing it replaces the domain. */
  emailService: string;
  /**
   * How the domain is managed. `AzureManaged` provisions a free
   * `*.azurecomm.net` subdomain with no DNS setup; `CustomerManaged` uses
   * your own domain and needs its DNS verification records published.
   * Changing it replaces the domain.
   * @default "AzureManaged"
   */
  domainManagement?: EmailDomainManagement;
  /**
   * Domain name. Must be `AzureManagedDomain` for an Azure-managed domain
   * (the default), otherwise the custom domain, e.g. `mail.example.com`.
   * Changing it replaces the domain.
   * @default "AzureManagedDomain" when `domainManagement` is `AzureManaged`
   */
  name?: string;
  /**
   * ARM location. Domains are global resources. Changing it replaces the
   * domain.
   * @default "global"
   */
  location?: string;
  /**
   * Whether open and click tracking is enabled. Azure-managed domains do not
   * support enabling it.
   * @default Azure's default (`Disabled`)
   */
  userEngagementTracking?: EmailUserEngagementTracking;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** A DNS record that must be published to verify a customer-managed domain. */
export interface EmailDomainDnsRecord {
  /** Record type, e.g. `TXT` or `CNAME`. */
  type: string | undefined;
  /** Record name. */
  name: string | undefined;
  /** Record value. */
  value: string | undefined;
  /** Time to live in seconds. */
  ttl: number | undefined;
}

/** DNS records used to verify a domain, by verification type. */
export interface EmailDomainVerificationRecords {
  /** Domain ownership TXT record. */
  domain: EmailDomainDnsRecord | undefined;
  /** SPF TXT record. */
  spf: EmailDomainDnsRecord | undefined;
  /** First DKIM CNAME record. */
  dkim: EmailDomainDnsRecord | undefined;
  /** Second DKIM CNAME record. */
  dkim2: EmailDomainDnsRecord | undefined;
  /** DMARC TXT record. */
  dmarc: EmailDomainDnsRecord | undefined;
}

/** Verification status, by verification type. */
export interface EmailDomainVerificationStates {
  /** Domain ownership verification status. */
  domain: string | undefined;
  /** SPF verification status. */
  spf: string | undefined;
  /** First DKIM verification status. */
  dkim: string | undefined;
  /** Second DKIM verification status. */
  dkim2: string | undefined;
  /** DMARC verification status. */
  dmarc: string | undefined;
}

export interface EmailDomain extends Resource<
  "Azure.Communication.EmailDomain",
  EmailDomainProps,
  {
    /** Name of the domain resource. */
    domainName: string;
    /** ARM resource ID of the domain; link it to a communication service. */
    domainId: string;
    /** Email service that holds the domain. */
    emailService: string;
    /** Resource group of the email service. */
    resourceGroup: string;
    /** ARM location of the domain (`global`). */
    location: string;
    /** How the domain is managed. */
    domainManagement: string;
    /** Sender domain shown to recipients (RFC 5322 `From`). */
    fromSenderDomain: string | undefined;
    /** Envelope sender domain (RFC 5321 `MAIL FROM`). */
    mailFromSenderDomain: string | undefined;
    /** Geography where the domain's data is stored at rest. */
    dataLocation: string | undefined;
    /** Whether open and click tracking is enabled. */
    userEngagementTracking: string | undefined;
    /** DNS records to publish to verify a customer-managed domain. */
    verificationRecords: EmailDomainVerificationRecords;
    /** Verification status of each record. */
    verificationStates: EmailDomainVerificationStates;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A sender domain of an Azure Communication Services email service.
 *
 * An Azure-managed domain (the default) gets a free `*.azurecomm.net`
 * sender domain that works immediately. A customer-managed domain uses your
 * own domain: publish the `verificationRecords` in its DNS zone, then start
 * verification in the portal or API before sending.
 *
 * @see https://learn.microsoft.com/azure/communication-services/concepts/email/email-domain-and-sender-authentication
 *
 * ### Azure-managed Domains
 * **Example:** Free azurecomm.net sender domain
 * ```typescript
 * const email = yield* Azure.Communication.EmailService("email", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const domain = yield* Azure.Communication.EmailDomain("domain", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 * });
 * // domain.fromSenderDomain → "<guid>.azurecomm.net"
 * ```
 *
 * ### Custom Domains
 * **Example:** Customer-managed domain with engagement tracking
 * ```typescript
 * const domain = yield* Azure.Communication.EmailDomain("custom", {
 *   resourceGroup: group.resourceGroupName,
 *   emailService: email.emailServiceName,
 *   domainManagement: "CustomerManaged",
 *   name: "mail.example.com",
 *   userEngagementTracking: "Enabled",
 * });
 * // publish domain.verificationRecords in the example.com DNS zone
 * ```
 *
 * ### Sending from a Communication Service
 * **Example:** Link the domain to a communication service
 * ```typescript
 * const acs = yield* Azure.Communication.CommunicationService("acs", {
 *   resourceGroup: group.resourceGroupName,
 *   linkedDomains: [domain.domainId],
 * });
 * ```
 *
 * @resource
 */
export const EmailDomain = Resource<EmailDomain>(
  "Azure.Communication.EmailDomain",
);

type ObservedDomain = communication.GetDomainResponse;

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
) =>
  orUndefinedIfNotFound(
    communication.GetDomain({
      subscriptionId,
      resourceGroupName,
      emailServiceName,
      domainName,
    }),
  );

const toRecord = (
  record: communication.DnsRecord | undefined,
): EmailDomainDnsRecord | undefined =>
  record === undefined
    ? undefined
    : {
        type: record.type,
        name: record.name,
        value: record.value,
        ttl: record.ttl,
      };

const toAttrs = (
  resourceGroup: string,
  emailService: string,
  name: string,
  observed: ObservedDomain,
): EmailDomain["Attributes"] => {
  const props = observed.properties;
  const records = props?.verificationRecords;
  const states = props?.verificationStates;
  return {
    domainName: name,
    domainId: observed.id ?? "",
    emailService,
    resourceGroup,
    location: observed.location,
    domainManagement: props?.domainManagement ?? "",
    fromSenderDomain: props?.fromSenderDomain,
    mailFromSenderDomain: props?.mailFromSenderDomain,
    dataLocation: props?.dataLocation,
    userEngagementTracking: props?.userEngagementTracking,
    verificationRecords: {
      domain: toRecord(records?.Domain),
      spf: toRecord(records?.SPF),
      dkim: toRecord(records?.DKIM),
      dkim2: toRecord(records?.DKIM2),
      dmarc: toRecord(records?.DMARC),
    },
    verificationStates: {
      domain: states?.Domain?.status,
      spf: states?.SPF?.status,
      dkim: states?.DKIM?.status,
      dkim2: states?.DKIM2?.status,
      dmarc: states?.DMARC?.status,
    },
    tags: userTags(observed.tags),
  };
};

const domainNameOf = (props: {
  name?: string;
  domainManagement?: string;
}): string | undefined =>
  props.name ??
  ((props.domainManagement ?? "AzureManaged") === "AzureManaged"
    ? AZURE_MANAGED_DOMAIN_NAME
    : undefined);

export const EmailDomainProvider = () =>
  Provider.succeed(EmailDomain, {
    stables: [
      "domainName",
      "domainId",
      "emailService",
      "resourceGroup",
      "location",
      "domainManagement",
      "fromSenderDomain",
      "mailFromSenderDomain",
      "dataLocation",
    ],

    // Domains live inside an email service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.emailService) !== lower(output.emailService) ||
        lower(domainNameOf(news)) !== lower(output.domainName) ||
        lower(news.domainManagement ?? "AzureManaged") !==
          lower(output.domainManagement) ||
        lower(news.location ?? GLOBAL_LOCATION) !== lower(output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const emailService = output?.emailService ?? olds?.emailService;
      const name =
        output?.domainName ??
        (olds === undefined ? undefined : domainNameOf(olds));
      if (
        resourceGroup === undefined ||
        emailService === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getDomain(
        subscriptionId,
        resourceGroup,
        emailService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, emailService, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Communication");
      const { resourceGroup, emailService } = news;
      const domainManagement = news.domainManagement ?? "AzureManaged";
      const name = domainNameOf(news);
      if (name === undefined) {
        return yield* new EmailDomainNameRequired({
          message: `EmailDomain '${id}': 'name' (the custom domain) is required when domainManagement is '${domainManagement}'`,
        });
      }
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        emailServiceName: emailService,
        domainName: name,
      };
      const get = getDomain(subscriptionId, resourceGroup, emailService, name);
      const label = `email domain ${emailService}/${name}`;
      const wait = () =>
        waitForProvisioned(
          label,
          get,
          (domain) => domain.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* communication.DomainsCreateOrUpdate({
          ...where,
          location: news.location ?? GLOBAL_LOCATION,
          tags,
          properties: {
            domainManagement,
            userEngagementTracking: news.userEngagementTracking,
          },
        });
      }
      observed = yield* wait();

      // Sync engagement tracking and tags against observed state.
      const trackingChanged =
        news.userEngagementTracking !== undefined &&
        observed.properties?.userEngagementTracking !==
          news.userEngagementTracking;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (trackingChanged || tagsChanged) {
        yield* communication.UpdateDomain({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: trackingChanged
            ? { userEngagementTracking: news.userEngagementTracking }
            : undefined,
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, emailService, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        communication.DeleteDomain({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          emailServiceName: output.emailService,
          domainName: output.domainName,
        }),
      );
      yield* waitUntilGone(
        `email domain ${output.emailService}/${output.domainName}`,
        getDomain(
          subscriptionId,
          output.resourceGroup,
          output.emailService,
          output.domainName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
