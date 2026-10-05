import * as domainservices from "@distilled.cloud/azure/domainservices";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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

export type DomainServiceSku = "Standard" | "Enterprise" | "Premium";
export type DomainServiceToggle = "Enabled" | "Disabled";

export interface DomainServiceReplicaSet {
  /**
   * Azure region of the replica set. The first replica set's region is the
   * managed domain's primary region.
   * @default the domain service's location
   */
  location?: string;
  /**
   * ARM ID of the dedicated subnet the domain controllers are deployed into.
   */
  subnetId: string;
}

export interface DomainServiceLdapsSettings {
  /** Enable Secure LDAP (LDAPS). */
  ldaps: DomainServiceToggle;
  /**
   * Base64-encoded PFX certificate for Secure LDAP. Write-only: Azure never
   * returns it, so a change is detected against the previous props.
   */
  pfxCertificate?: string | Redacted.Redacted<string>;
  /** Password that decrypts `pfxCertificate`. Write-only. */
  pfxCertificatePassword?: string | Redacted.Redacted<string>;
  /**
   * Allow Secure LDAP access over the internet.
   * @default Azure's default (`Disabled`)
   */
  externalAccess?: DomainServiceToggle;
}

export interface DomainServiceSecuritySettings {
  /** Allow NTLM v1 authentication. */
  ntlmV1?: DomainServiceToggle;
  /**
   * Allow TLS 1.0/1.1. Azure now rejects provisioning with it enabled
   * ("TLS 1.0 or 1.1 is currently deprecated"), so Alchemy defaults it off.
   * @default "Disabled"
   */
  tlsV1?: DomainServiceToggle;
  /** Synchronize NTLM password hashes. */
  syncNtlmPasswords?: DomainServiceToggle;
  /** Synchronize Kerberos password hashes. */
  syncKerberosPasswords?: DomainServiceToggle;
  /** Synchronize on-premises password hashes. */
  syncOnPremPasswords?: DomainServiceToggle;
  /** Allow Kerberos RC4 encryption. */
  kerberosRc4Encryption?: DomainServiceToggle;
  /** Enable Kerberos armoring (FAST). */
  kerberosArmoring?: DomainServiceToggle;
  /** Require LDAP signing. */
  ldapSigning?: DomainServiceToggle;
  /** Require LDAP channel binding. */
  channelBinding?: DomainServiceToggle;
}

export interface DomainServiceNotificationSettings {
  /** Notify Microsoft Entra global administrators of alerts. */
  notifyGlobalAdmins?: DomainServiceToggle;
  /** Notify members of the `AAD DC Administrators` group of alerts. */
  notifyDcAdmins?: DomainServiceToggle;
  /** Additional email recipients for alerts. */
  additionalRecipients?: string[];
}

export interface DomainServiceForestTrust {
  /** FQDN of the trusted (on-premises) domain. */
  trustedDomainFqdn: string;
  /** Trust direction, e.g. `Outbound`. */
  trustDirection: string;
  /** Display name of the trust. */
  friendlyName: string;
  /** Comma-separated DNS server IPs of the trusted domain. */
  remoteDnsIps: string;
  /** Trust password. Write-only. */
  trustPassword?: string | Redacted.Redacted<string>;
}

export interface DomainServiceResourceForestSettings {
  /** Resource forest name. */
  resourceForest?: string;
  /** Forest trusts. */
  settings?: DomainServiceForestTrust[];
}

export interface DomainServiceProps {
  /**
   * Resource group the managed domain is created in. Changing it replaces
   * the managed domain.
   */
  resourceGroup: string;
  /**
   * DNS name of the managed domain, e.g. `aaddscontoso.com` or a verified
   * `<tenant>.onmicrosoft.com` domain. Changing it replaces the managed
   * domain.
   */
  domainName: string;
  /**
   * Name of the Azure resource. By convention it equals `domainName`.
   * Changing it replaces the managed domain.
   * @default domainName
   */
  name?: string;
  /**
   * Primary Azure region. Changing it replaces the managed domain.
   * @default the first replica set's location, else the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Replica sets (domain controller pairs). The first entry is the primary
   * replica set; changing its subnet or region replaces the managed domain.
   * Additional replica sets (Enterprise/Premium) can be added or removed.
   */
  replicaSets: DomainServiceReplicaSet[];
  /**
   * SKU of the managed domain.
   * @default "Standard"
   */
  sku?: DomainServiceSku;
  /**
   * Domain configuration type. Changing it replaces the managed domain.
   * @default "FullySynced"
   */
  domainConfigurationType?: "FullySynced" | "ResourceTrusting";
  /**
   * Group-based filtered synchronization from Microsoft Entra ID.
   * @default Azure's default (`Disabled`)
   */
  filteredSync?: DomainServiceToggle;
  /**
   * Which users are synchronized: `All` or `CloudOnly`. Changing it
   * triggers a resynchronization.
   * @default Azure's default (`All`)
   */
  syncScope?: "All" | "CloudOnly";
  /** Secure LDAP settings. */
  ldapsSettings?: DomainServiceLdapsSettings;
  /** Domain security settings (NTLM, TLS, Kerberos, LDAP hardening). */
  domainSecuritySettings?: DomainServiceSecuritySettings;
  /** Alert notification settings. */
  notificationSettings?: DomainServiceNotificationSettings;
  /** Resource forest trusts (Enterprise/Premium). */
  resourceForestSettings?: DomainServiceResourceForestSettings;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DomainServiceReplicaSetAttributes {
  /** ID of the replica set. */
  replicaSetId: string | undefined;
  /** Region of the replica set. */
  location: string | undefined;
  /** ARM ID of the subnet the domain controllers run in. */
  subnetId: string | undefined;
  /**
   * Private IPs of the domain controllers; set them as the DNS servers of
   * the virtual network.
   */
  domainControllerIpAddresses: string[];
  /** Public IP used for Secure LDAP external access. */
  externalAccessIpAddress: string | undefined;
  /** Health status of the replica set. */
  serviceStatus: string | undefined;
}

export interface DomainService extends Resource<
  "Azure.DomainServices.DomainService",
  DomainServiceProps,
  {
    /** Name of the Azure resource. */
    domainServiceName: string;
    /** ARM resource ID of the managed domain. */
    domainServiceId: string;
    /** Resource group that holds the managed domain. */
    resourceGroup: string;
    /** Primary region. */
    location: string;
    /** DNS name of the managed domain. */
    domainName: string;
    /** Deployment ID Azure assigned to the managed domain. */
    deploymentId: string | undefined;
    /** Microsoft Entra tenant the domain synchronizes from. */
    tenantId: string | undefined;
    /** Replica set that owns synchronization. */
    syncOwner: string | undefined;
    /** Data model version. */
    version: number | undefined;
    /** SKU of the managed domain. */
    sku: string | undefined;
    /** Domain configuration type. */
    domainConfigurationType: string | undefined;
    /** Replica sets with their domain controller IPs. */
    replicaSets: DomainServiceReplicaSetAttributes[];
    /** Public certificate of the Secure LDAP configuration. */
    ldapsPublicCertificate: string | undefined;
    /** Thumbprint of the Secure LDAP certificate. */
    ldapsCertificateThumbprint: string | undefined;
    /** Expiry of the Secure LDAP certificate. */
    ldapsCertificateNotAfter: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Microsoft Entra Domain Services — a managed Active Directory domain
 * (domain controllers, LDAP, Kerberos, NTLM, Group Policy) deployed into a
 * dedicated subnet of your virtual network and synchronized from Microsoft
 * Entra ID.
 *
 * Only one managed domain can exist per Entra tenant, so every replacement
 * deletes the old domain before creating the new one. Provisioning takes
 * 45-60 minutes and deletion about 30; the Standard SKU costs about
 * $0.15/hour. The tenant must contain the "Domain Controller Services"
 * service principal (app ID `2565bd9d-da50-47d4-8b85-4c97f669dc36`).
 *
 * @see https://learn.microsoft.com/entra/identity/domain-services/overview
 *
 * ### Creating a Managed Domain
 * **Example:** Standard managed domain in a dedicated subnet
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("identity");
 * const vnet = yield* Azure.Network.VirtualNetwork("identity", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("aadds", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/24",
 * });
 * const domain = yield* Azure.DomainServices.DomainService("domain", {
 *   resourceGroup: group.resourceGroupName,
 *   domainName: "aaddscontoso.com",
 *   replicaSets: [{ subnetId: subnet.subnetId }],
 * });
 * ```
 *
 * ### Hardening and Notifications
 * **Example:** Disable legacy protocols and notify admins
 * ```typescript
 * const domain = yield* Azure.DomainServices.DomainService("domain", {
 *   resourceGroup: group.resourceGroupName,
 *   domainName: "aaddscontoso.com",
 *   replicaSets: [{ subnetId: subnet.subnetId }],
 *   domainSecuritySettings: {
 *     ntlmV1: "Disabled",
 *     tlsV1: "Disabled",
 *     kerberosRc4Encryption: "Disabled",
 *   },
 *   notificationSettings: {
 *     notifyGlobalAdmins: "Enabled",
 *     additionalRecipients: ["ops@contoso.com"],
 *   },
 * });
 * ```
 *
 * ### Secure LDAP
 * **Example:** Enable LDAPS with a PFX certificate
 * ```typescript
 * const domain = yield* Azure.DomainServices.DomainService("domain", {
 *   resourceGroup: group.resourceGroupName,
 *   domainName: "aaddscontoso.com",
 *   replicaSets: [{ subnetId: subnet.subnetId }],
 *   ldapsSettings: {
 *     ldaps: "Enabled",
 *     pfxCertificate: Redacted.make(pfxBase64),
 *     pfxCertificatePassword: Redacted.make(pfxPassword),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DomainService = Resource<DomainService>(
  "Azure.DomainServices.DomainService",
);

type Observed = domainservices.GetDomainServiceResponse;

const lower = (value: string | undefined) => value?.toLowerCase();

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const getDomainService = (
  subscriptionId: string,
  resourceGroupName: string,
  domainServiceName: string,
) =>
  orUndefinedIfNotFound(
    domainservices.GetDomainService({
      subscriptionId,
      resourceGroupName,
      domainServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): DomainService["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    domainServiceName: name,
    domainServiceId: observed.id ?? "",
    resourceGroup,
    location: observed.location ?? "",
    domainName: props.domainName ?? "",
    deploymentId: props.deploymentId,
    tenantId: props.tenantId,
    syncOwner: props.syncOwner,
    version: props.version,
    sku: props.sku,
    domainConfigurationType: props.domainConfigurationType,
    replicaSets: (props.replicaSets ?? []).map((set) => ({
      replicaSetId: set.replicaSetId,
      location: set.location,
      subnetId: set.subnetId,
      domainControllerIpAddresses: set.domainControllerIpAddress ?? [],
      externalAccessIpAddress: set.externalAccessIpAddress,
      serviceStatus: set.serviceStatus,
    })),
    ldapsPublicCertificate: props.ldapsSettings?.publicCertificate,
    ldapsCertificateThumbprint: props.ldapsSettings?.certificateThumbprint,
    ldapsCertificateNotAfter: props.ldapsSettings?.certificateNotAfter,
    tags: userTags(observed.tags),
  };
};

/** Whether every field set in `desired` equals the observed field. */
const matches = <T extends object>(
  observed: object | undefined,
  desired: T,
): boolean =>
  Object.entries(desired).every(([key, value]) => {
    if (value === undefined) return true;
    const current = (observed as Record<string, unknown> | undefined)?.[key];
    if (Array.isArray(value)) {
      const have = Array.isArray(current) ? [...current].sort() : [];
      return JSON.stringify([...value].sort()) === JSON.stringify(have);
    }
    return current === value;
  });

const replicaKey = (set: { location?: string; subnetId?: string }) =>
  `${lower(set.location)}|${lower(set.subnetId)}`;

// Provisioning takes 45-60 minutes; deletion about 30.
const PROVISION_BUDGET = { interval: "60 seconds", times: 75 } as const;
const DELETE_BUDGET = { interval: "60 seconds", times: 60 } as const;

export const DomainServiceProvider = () =>
  Provider.succeed(DomainService, {
    stables: [
      "domainServiceName",
      "domainServiceId",
      "resourceGroup",
      "location",
      "domainName",
      "deploymentId",
      "tenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* domainservices
        .ListDomainServices({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDomainServices", page),
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
      const primary = news.replicaSets[0];
      const observedPrimary = output.replicaSets[0];
      const location = news.location ?? primary?.location ?? output.location;
      // Only one managed domain may exist per tenant: delete first.
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.name ?? news.domainName) !==
          lower(output.domainServiceName) ||
        lower(news.domainName) !== lower(output.domainName) ||
        lower(location) !== lower(output.location) ||
        (news.domainConfigurationType ?? "FullySynced") !==
          (output.domainConfigurationType ?? "FullySynced") ||
        (observedPrimary !== undefined &&
          lower(primary?.subnetId) !== lower(observedPrimary.subnetId))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const name = output?.domainServiceName ?? olds?.name ?? olds?.domainName;
      if (resourceGroup === undefined || name === undefined) return undefined;
      const observed = yield* getDomainService(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AAD");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.domainServiceName ?? news.domainName;
      const location =
        news.location ??
        news.replicaSets[0]?.location ??
        output?.location ??
        env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Standard";
      const replicaSets = news.replicaSets.map((set) => ({
        location: set.location ?? location,
        subnetId: set.subnetId,
      }));
      const ldapsSettings =
        news.ldapsSettings === undefined
          ? undefined
          : {
              ldaps: news.ldapsSettings.ldaps,
              externalAccess: news.ldapsSettings.externalAccess,
              pfxCertificate: reveal(news.ldapsSettings.pfxCertificate),
              pfxCertificatePassword: reveal(
                news.ldapsSettings.pfxCertificatePassword,
              ),
            };
      // Azure's own default (tlsV1 Enabled) now fails provisioning.
      const domainSecuritySettings: DomainServiceSecuritySettings = {
        tlsV1: "Disabled",
        ...news.domainSecuritySettings,
      };
      const resourceForestSettings =
        news.resourceForestSettings === undefined
          ? undefined
          : {
              resourceForest: news.resourceForestSettings.resourceForest,
              settings: news.resourceForestSettings.settings?.map((trust) => ({
                ...trust,
                trustPassword: reveal(trust.trustPassword),
              })),
            };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainServiceName: name,
      };
      const label = `domain service ${name}`;
      const get = getDomainService(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation (45-60 minutes).
      const created = observed === undefined;
      if (observed === undefined) {
        yield* domainservices.DomainServicesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            domainName: news.domainName,
            replicaSets,
            sku,
            domainConfigurationType: news.domainConfigurationType,
            filteredSync: news.filteredSync,
            syncScope: news.syncScope,
            ldapsSettings,
            domainSecuritySettings,
            notificationSettings: news.notificationSettings,
            resourceForestSettings,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => service.properties?.provisioningState,
        PROVISION_BUDGET,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: domainservices.DomainServicePropertiesInput = {};
      if (props.sku !== sku) changed.sku = sku;
      if (
        news.filteredSync !== undefined &&
        props.filteredSync !== news.filteredSync
      ) {
        changed.filteredSync = news.filteredSync;
      }
      if (news.syncScope !== undefined && props.syncScope !== news.syncScope) {
        changed.syncScope = news.syncScope;
      }
      const observedReplicas = (props.replicaSets ?? []).map(replicaKey).sort();
      const desiredReplicas = replicaSets.map(replicaKey).sort();
      if (
        JSON.stringify(observedReplicas) !== JSON.stringify(desiredReplicas)
      ) {
        changed.replicaSets = replicaSets;
      }
      if (
        !matches(props.domainSecuritySettings, domainSecuritySettings)
      ) {
        changed.domainSecuritySettings = {
          ...props.domainSecuritySettings,
          ...domainSecuritySettings,
        };
      }
      if (
        news.notificationSettings !== undefined &&
        !matches(props.notificationSettings, news.notificationSettings)
      ) {
        changed.notificationSettings = {
          ...props.notificationSettings,
          ...news.notificationSettings,
        };
      }
      if (ldapsSettings !== undefined) {
        // The PFX is write-only; previous props are its only baseline.
        const certificateChanged =
          !created &&
          (olds === undefined ||
            reveal(olds.ldapsSettings?.pfxCertificate) !==
              ldapsSettings.pfxCertificate ||
            reveal(olds.ldapsSettings?.pfxCertificatePassword) !==
              ldapsSettings.pfxCertificatePassword);
        if (
          !matches(props.ldapsSettings, {
            ldaps: ldapsSettings.ldaps,
            externalAccess: ldapsSettings.externalAccess,
          }) ||
          (ldapsSettings.pfxCertificate !== undefined && certificateChanged)
        ) {
          changed.ldapsSettings = ldapsSettings;
        }
      }
      if (resourceForestSettings !== undefined) {
        const observedForest = props.resourceForestSettings;
        const trustKey = (trust: {
          trustedDomainFqdn?: string;
          trustDirection?: string;
          friendlyName?: string;
          remoteDnsIps?: string;
        }) =>
          [
            lower(trust.trustedDomainFqdn),
            trust.trustDirection,
            trust.friendlyName,
            trust.remoteDnsIps,
          ].join("|");
        const passwordsChanged =
          !created &&
          (olds === undefined ||
            JSON.stringify(
              (olds.resourceForestSettings?.settings ?? []).map((trust) =>
                reveal(trust.trustPassword),
              ),
            ) !==
              JSON.stringify(
                (resourceForestSettings.settings ?? []).map(
                  (trust) => trust.trustPassword,
                ),
              ));
        if (
          (resourceForestSettings.resourceForest !== undefined &&
            observedForest?.resourceForest !==
              resourceForestSettings.resourceForest) ||
          JSON.stringify(
            (observedForest?.settings ?? []).map(trustKey).sort(),
          ) !==
            JSON.stringify(
              (resourceForestSettings.settings ?? []).map(trustKey).sort(),
            ) ||
          passwordsChanged
        ) {
          changed.resourceForestSettings = resourceForestSettings;
        }
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* domainservices.UpdateDomainService({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) => service.properties?.provisioningState,
          PROVISION_BUDGET,
        );
      }

      // Usable once the primary replica set reports its DC IPs, which
      // appear shortly after provisioning succeeds.
      observed = yield* get.pipe(
        Effect.repeat({
          until: (service) =>
            (service?.properties?.replicaSets?.[0]?.domainControllerIpAddress
              ?.length ?? 0) > 0,
          schedule: Schedule.spaced("30 seconds"),
          times: 40,
        }),
        Effect.flatMap((service) =>
          service === undefined
            ? waitForProvisioned(
                label,
                get,
                (s) => s.properties?.provisioningState,
                PROVISION_BUDGET,
              )
            : Effect.succeed(service),
        ),
      );

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        domainservices.DeleteDomainService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainServiceName: output.domainServiceName,
        }),
      );
      yield* waitUntilGone(
        `domain service ${output.domainServiceName}`,
        getDomainService(
          subscriptionId,
          output.resourceGroup,
          output.domainServiceName,
        ),
        DELETE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
