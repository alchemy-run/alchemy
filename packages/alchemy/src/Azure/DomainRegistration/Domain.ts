import * as domainregistration from "@distilled.cloud/azure/domainregistration";
import * as Clock from "effect/Clock";
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

/** Mailing address of a domain contact. */
export interface DomainContactAddress {
  /** First line of the address. */
  address1: string;
  /** Second line of the address. */
  address2?: string;
  /** City. */
  city: string;
  /** Two-letter country code, e.g. `US`. */
  country: string;
  /** Postal code. */
  postalCode: string;
  /** State or province. */
  state: string;
}

/**
 * A domain contact. Without domain privacy, contact information is published
 * in the WHOIS directory as required by ICANN.
 */
export interface DomainContact {
  /** Mailing address. */
  addressMailing?: DomainContactAddress;
  /** Email address. */
  email: string;
  /** Fax number. */
  fax?: string;
  /** Job title. */
  jobTitle?: string;
  /** First name. */
  nameFirst: string;
  /** Last name. */
  nameLast: string;
  /** Middle name. */
  nameMiddle?: string;
  /** Organization the contact belongs to. */
  organization?: string;
  /** Phone number in `+<country>.<number>` form, e.g. `+1.4255550100`. */
  phone: string;
}

/** Acceptance of the top-level domain's legal agreements. */
export interface DomainConsent {
  /**
   * IP address of the client accepting the agreements. Recorded by the
   * registrar as proof of consent.
   */
  agreedBy: string;
  /**
   * ISO-8601 timestamp the agreements were accepted. If omitted, the time of
   * purchase is used.
   */
  agreedAt?: string;
  /**
   * Keys of the accepted legal agreements. If omitted, every agreement
   * returned by the TLD's `listAgreements` API (including the privacy
   * agreement when `privacy` is enabled) is accepted.
   */
  agreementKeys?: string[];
}

/** DNS hosting for a purchased domain. */
export type DomainDnsType = "AzureDns" | "DefaultDomainRegistrarDns";

export interface DomainProps {
  /**
   * Resource group the domain is created in. Changing it replaces the
   * domain (and purchases a new registration).
   */
  resourceGroup: string;
  /**
   * The fully qualified domain name to register, e.g. `example.com`. Must be
   * available for registration. Changing it replaces the domain.
   */
  domainName: string;
  /**
   * Registrant contact. Updated in place.
   */
  contactRegistrant: DomainContact;
  /**
   * Administrative contact. Updated in place.
   * @default contactRegistrant
   */
  contactAdmin?: DomainContact;
  /**
   * Billing contact. Updated in place.
   * @default contactRegistrant
   */
  contactBilling?: DomainContact;
  /**
   * Technical contact. Updated in place.
   * @default contactRegistrant
   */
  contactTech?: DomainContact;
  /**
   * Explicit acceptance of the TLD's legal agreements. Required by the
   * registrar to purchase the domain. Only used when purchasing.
   */
  consent: DomainConsent;
  /**
   * Whether WHOIS domain privacy is enabled. Updated in place.
   * @default true
   */
  privacy?: boolean;
  /**
   * Whether Azure renews the registration automatically every year.
   * Updated in place.
   * @default true
   */
  autoRenew?: boolean;
  /**
   * DNS hosting for the domain. `AzureDns` delegates the domain to the
   * Azure DNS zone in `dnsZoneId`. Updated in place.
   * @default "AzureDns" when `dnsZoneId` is set
   */
  dnsType?: DomainDnsType;
  /**
   * ARM resource ID of the Azure DNS zone that hosts the domain. Updated in
   * place.
   */
  dnsZoneId?: string;
  /**
   * Delete the registration immediately on destroy. By default Azure
   * soft-deletes the domain and releases it after 24 hours, during which it
   * can be restored at no cost. Deleting never refunds the purchase.
   * @default false
   */
  forceHardDelete?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Domain extends Resource<
  "Azure.DomainRegistration.Domain",
  DomainProps,
  {
    /** The registered domain name, e.g. `example.com`. */
    domainName: string;
    /** Resource group that holds the domain. */
    resourceGroup: string;
    /** ARM resource ID of the domain. */
    domainId: string;
    /** Location of the domain (`global`). */
    location: string;
    /** Registration status, e.g. `Active` or `Pending`. */
    registrationStatus: string | undefined;
    /** Provisioning state of the domain. */
    provisioningState: string | undefined;
    /** Name servers the domain is delegated to. */
    nameServers: string[];
    /** Whether WHOIS domain privacy is enabled. */
    privacy: boolean | undefined;
    /** Whether the registration renews automatically. */
    autoRenew: boolean | undefined;
    /** DNS hosting type of the domain. */
    dnsType: string | undefined;
    /** ARM resource ID of the Azure DNS zone hosting the domain. */
    dnsZoneId: string | undefined;
    /** Whether Azure can manage DNS records and assign the domain to apps. */
    readyForDnsRecordManagement: boolean | undefined;
    /** Registration timestamp. */
    createdTime: string | undefined;
    /** Registration expiration timestamp. */
    expirationTime: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An App Service Domain — a real DNS domain registration purchased through
 * Azure (registered via GoDaddy) and optionally hosted in Azure DNS.
 *
 * Creating a domain is a real, non-refundable purchase billed yearly
 * (~$12/year for `.com`, more for premium TLDs). Free-trial and
 * spending-limit subscriptions cannot purchase App Service Domains.
 * Deleting the resource releases the registration without a refund.
 *
 * @see https://learn.microsoft.com/azure/app-service/manage-custom-dns-buy-domain
 *
 * ### Buying a Domain
 * **Example:** Register a domain hosted in Azure DNS
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("domains");
 * const zone = yield* Azure.Dns.Zone("example", {
 *   resourceGroup: group.resourceGroupName,
 *   zoneName: "example.com",
 * });
 * const domain = yield* Azure.DomainRegistration.Domain("example", {
 *   resourceGroup: group.resourceGroupName,
 *   domainName: "example.com",
 *   dnsZoneId: zone.zoneId,
 *   contactRegistrant: {
 *     email: "hostmaster@example.com",
 *     nameFirst: "Ada",
 *     nameLast: "Lovelace",
 *     phone: "+1.4255550100",
 *     addressMailing: {
 *       address1: "1 Microsoft Way",
 *       city: "Redmond",
 *       state: "WA",
 *       postalCode: "98052",
 *       country: "US",
 *     },
 *   },
 *   consent: { agreedBy: "203.0.113.10" },
 * });
 * ```
 *
 * ### Renewal and Privacy
 * **Example:** Disable auto-renew and WHOIS privacy
 * ```typescript
 * const domain = yield* Azure.DomainRegistration.Domain("example", {
 *   resourceGroup: group.resourceGroupName,
 *   domainName: "example.com",
 *   contactRegistrant: registrant,
 *   consent: { agreedBy: "203.0.113.10" },
 *   autoRenew: false,
 *   privacy: false,
 * });
 * ```
 *
 * @resource
 */
export const Domain = Resource<Domain>("Azure.DomainRegistration.Domain");

type ObservedDomain = domainregistration.GetDomainResponse;
type ContactInput = domainregistration.Contact;

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
) =>
  orUndefinedIfNotFound(
    domainregistration.GetDomain({
      subscriptionId,
      resourceGroupName,
      domainName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  domain: ObservedDomain | domainregistration.Domain,
): Domain["Attributes"] => ({
  domainName: name,
  resourceGroup,
  domainId: domain.id ?? "",
  location: domain.location,
  registrationStatus: domain.properties?.registrationStatus,
  provisioningState: domain.properties?.provisioningState,
  nameServers: [...(domain.properties?.nameServers ?? [])],
  privacy: domain.properties?.privacy,
  autoRenew: domain.properties?.autoRenew,
  dnsType: domain.properties?.dnsType,
  dnsZoneId: domain.properties?.dnsZoneId,
  readyForDnsRecordManagement: domain.properties?.readyForDnsRecordManagement,
  createdTime: domain.properties?.createdTime,
  expirationTime: domain.properties?.expirationTime,
  tags: userTags(domain.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/** Top-level domain of a domain name (`example.co.uk` → `co.uk`). */
const topLevelDomainOf = (domainName: string) =>
  domainName.slice(domainName.indexOf(".") + 1).toLowerCase();

/**
 * Whether every field the user specified on a contact matches the observed
 * contact. Fields the user left out are not compared.
 */
const contactMatches = (
  observed: ContactInput | undefined,
  desired: ContactInput,
) => {
  if (observed === undefined) return false;
  const scalarKeys = [
    "email",
    "fax",
    "jobTitle",
    "nameFirst",
    "nameLast",
    "nameMiddle",
    "organization",
    "phone",
  ] as const;
  for (const key of scalarKeys) {
    if (desired[key] !== undefined && desired[key] !== observed[key]) {
      return false;
    }
  }
  const desiredAddress = desired.addressMailing;
  if (desiredAddress !== undefined) {
    const observedAddress = observed.addressMailing;
    if (observedAddress === undefined) return false;
    for (const key of [
      "address1",
      "address2",
      "city",
      "country",
      "postalCode",
      "state",
    ] as const) {
      if (
        desiredAddress[key] !== undefined &&
        desiredAddress[key] !== observedAddress[key]
      ) {
        return false;
      }
    }
  }
  return true;
};

const desiredContacts = (news: DomainProps) => ({
  contactRegistrant: news.contactRegistrant,
  contactAdmin: news.contactAdmin ?? news.contactRegistrant,
  contactBilling: news.contactBilling ?? news.contactRegistrant,
  contactTech: news.contactTech ?? news.contactRegistrant,
});

const desiredDnsType = (news: DomainProps): DomainDnsType | undefined =>
  news.dnsType ?? (news.dnsZoneId !== undefined ? "AzureDns" : undefined);

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["domainName", "resourceGroup", "domainId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* domainregistration
        .ListDomains({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListDomains", page)));
      return (page.value ?? []).flatMap((domain) => {
        const group = resourceGroupOf(domain.id);
        return hasAnyAlchemyTag(domain.tags) &&
          group !== undefined &&
          domain.name !== undefined
          ? [toAttrs(group, domain.name, domain)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.domainName) !== lower(output.domainName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const name = output?.domainName ?? olds?.domainName;
      if (resourceGroup === undefined || name === undefined) return undefined;
      const observed = yield* getDomain(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DomainRegistration");
      const resourceGroup = news.resourceGroup;
      const name = news.domainName;
      const tags = yield* desiredTags(id, news.tags);
      const contacts = desiredContacts(news);
      const privacy = news.privacy ?? true;
      const autoRenew = news.autoRenew ?? true;
      const dnsType = desiredDnsType(news);
      const target = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainName: name,
      };
      const get = getDomain(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `domain ${name}`,
        get,
        (domain) => domain.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure: creating the domain purchases the registration.
      if (observed === undefined) {
        const agreementKeys =
          news.consent.agreementKeys ??
          (yield* domainregistration
            .ListTopLevelDomainAgreements({
              subscriptionId,
              name: topLevelDomainOf(name),
              includePrivacy: privacy,
              forTransfer: false,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListTopLevelDomainAgreements", page),
              ),
              Effect.map((page) =>
                (page.value ?? []).map((agreement) => agreement.agreementKey),
              ),
            ));
        const agreedAt =
          news.consent.agreedAt ??
          new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* domainregistration.DomainsCreateOrUpdate({
          ...target,
          location: "global",
          tags,
          properties: {
            ...contacts,
            privacy,
            autoRenew,
            dnsType,
            dnsZoneId: news.dnsZoneId,
            consent: {
              agreementKeys,
              agreedBy: news.consent.agreedBy,
              agreedAt,
            },
          },
        });
        observed = yield* waitReady;
      }

      // Sync renewal, privacy, DNS hosting and contacts against the observed
      // domain. The PATCH body requires the contacts and consent.
      const props = observed.properties;
      const contactsDrifted =
        !contactMatches(props?.contactRegistrant, contacts.contactRegistrant) ||
        !contactMatches(props?.contactAdmin, contacts.contactAdmin) ||
        !contactMatches(props?.contactBilling, contacts.contactBilling) ||
        !contactMatches(props?.contactTech, contacts.contactTech);
      const dnsDrifted =
        (news.dnsZoneId !== undefined &&
          lower(news.dnsZoneId) !== lower(props?.dnsZoneId)) ||
        (dnsType !== undefined && dnsType !== props?.dnsType);
      if (
        props?.autoRenew !== autoRenew ||
        props?.privacy !== privacy ||
        dnsDrifted ||
        contactsDrifted
      ) {
        yield* domainregistration.UpdateDomain({
          ...target,
          properties: {
            ...contacts,
            privacy,
            autoRenew,
            consent: props?.consent ?? {
              agreementKeys: news.consent.agreementKeys,
              agreedBy: news.consent.agreedBy,
              agreedAt: news.consent.agreedAt,
            },
            dnsZoneId: news.dnsZoneId ?? props?.dnsZoneId,
            targetDnsType: dnsDrifted ? dnsType : undefined,
          },
        });
        observed = yield* waitReady;
      }

      // Sync tags: the PATCH body carries no tags, so re-PUT the observed
      // domain with the desired tags (an update of an owned registration,
      // not a new purchase).
      if (tagsDiffer(observed.tags, tags)) {
        const current = observed.properties;
        yield* domainregistration.DomainsCreateOrUpdate({
          ...target,
          location: observed.location,
          tags,
          properties: {
            ...contacts,
            privacy: current?.privacy ?? privacy,
            autoRenew: current?.autoRenew ?? autoRenew,
            dnsType: current?.dnsType,
            dnsZoneId: current?.dnsZoneId,
            consent: current?.consent ?? {
              agreementKeys: news.consent.agreementKeys,
              agreedBy: news.consent.agreedBy,
              agreedAt: news.consent.agreedAt,
            },
          },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        domainregistration.DeleteDomain({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domainName,
          forceHardDeleteDomain: olds?.forceHardDelete ?? false,
        }),
      );
      yield* waitUntilGone(
        `domain ${output.domainName}`,
        getDomain(subscriptionId, output.resourceGroup, output.domainName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
