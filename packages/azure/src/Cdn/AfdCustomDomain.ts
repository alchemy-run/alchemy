import * as cdn from "@distilled.cloud/azure/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  profileOwnedByStack,
  ref,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdCustomDomainTlsSettings {
  /**
   * Certificate source: a Front Door managed certificate, or your own
   * certificate from a `Secret`.
   * @default "ManagedCertificate"
   */
  certificateType?:
    | "ManagedCertificate"
    | "CustomerCertificate"
    | "AzureFirstPartyManagedCertificate";
  /** Minimum TLS version clients must use (with `cipherSuiteSetType: "Customized"`). */
  minimumTlsVersion?: "TLS10" | "TLS12" | "TLS13";
  /** Predefined cipher suite set offered to clients. */
  cipherSuiteSetType?: "Customized" | "TLS10_2019" | "TLS12_2022" | "TLS12_2023";
  /**
   * ARM ID of the `Azure.Cdn.Secret` holding the certificate
   * (`secret.secretId`), for `CustomerCertificate`.
   */
  secretId?: string;
}

export interface AfdCustomDomainProps {
  /** Resource group of the profile. Changing it replaces the domain. */
  resourceGroup: string;
  /** Front Door profile that holds the domain. Changing it replaces the domain. */
  profile: string;
  /**
   * Domain resource name: letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the domain.
   */
  name?: string;
  /** Host name served, e.g. `www.example.com`. Changing it replaces the domain. */
  hostName: string;
  /** HTTPS settings. @default a Front Door managed certificate */
  tlsSettings?: AfdCustomDomainTlsSettings;
  /**
   * Mutual TLS scenario: whether Front Door requires client certificates
   * and who validates them (not for wildcard host names).
   * @default no mutual TLS
   */
  mtlsScenario?:
    | "ClientCertificateRequiredAndValidated"
    | "ClientCertificateRequiredAndOriginValidates"
    | "ClientCertificateValidatedIfPresented"
    | "CompleteMtlsPassthroughToOrigin";
  /**
   * ARM ID of the Azure DNS zone hosting the domain (`zone.zoneId`).
   * @default none
   */
  azureDnsZoneId?: string;
  /**
   * ARM ID of a resource where domain ownership was pre-validated.
   * @default none
   */
  preValidatedCustomDomainResourceId?: string;
}

export interface AfdCustomDomain extends Resource<
  "Azure.Cdn.AfdCustomDomain",
  AfdCustomDomainProps,
  {
    /** Name of the domain resource. */
    customDomainName: string;
    /** ARM resource ID of the domain; reference it from routes and security policies. */
    customDomainId: string;
    /** Front Door profile that holds the domain. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Host name served. */
    hostName: string;
    /** Domain validation state (`Pending`, `Approved`, ...). */
    domainValidationState: string | undefined;
    /** Value for the `_dnsauth.<hostName>` TXT record that proves ownership. */
    validationToken: string | undefined;
    /** When the validation token expires. */
    validationTokenExpiration: string | undefined;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom domain on a Front Door profile
 * (`Microsoft.Cdn/profiles/customDomains`): serves an endpoint's routes
 * under your own host name, with HTTPS.
 *
 * Front Door validates ownership asynchronously: publish `validationToken`
 * as a TXT record at `_dnsauth.<hostName>` (or set `azureDnsZoneId`) and
 * point a CNAME at the endpoint. The deploy does not wait for validation,
 * which can take hours. By default Front Door issues and renews a managed
 * certificate for the domain once it validates.
 *
 * :::caution[Changing `hostName`, `name`, `profile`, or `resourceGroup` replaces the domain]
 * Alchemy creates a new domain resource and deletes the old one. The new
 * one has a new `validationToken`, so ownership must validate again and
 * HTTPS on the name fails until it does.
 * :::
 *
 * :::caution[Updates fail while validation is pending]
 * Front Door rejects every update to a domain whose
 * `domainValidationState` is `Submitting` or `Pending`. Alchemy retries for
 * one minute, then fails with `Azure.Cdn.AfdCustomDomainValidationPending`.
 * Publish the `_dnsauth` TXT record first.
 * :::
 *
 * @see https://learn.microsoft.com/azure/frontdoor/standard-premium/how-to-add-custom-domain
 *
 * ### Creating a Custom Domain
 * **Example:** Managed-certificate domain on a route
 * ```typescript
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.example.com",
 *   tlsSettings: { certificateType: "ManagedCertificate", minimumTlsVersion: "TLS12" },
 * });
 * const route = yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   customDomainIds: [domain.customDomainId],
 * });
 * // TXT _dnsauth.www.example.com = domain.validationToken
 * ```
 *
 * **Example:** Minimal domain with a managed certificate
 * ```typescript
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.example.com",
 * });
 * ```
 *
 * ### Validating with Azure DNS
 * When the domain's zone is in Azure DNS, create the TXT and CNAME record
 * sets in the same stack and link the zone with `azureDnsZoneId`.
 *
 * **Example:** `www.contoso.com` validated and routed
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.contoso.com",
 *   azureDnsZoneId: zone.zoneId,
 * });
 * yield* Azure.Dns.RecordSet("www-dnsauth", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "_dnsauth.www",
 *   txtRecords: [domain.validationToken.as<string>()],
 * });
 * yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: endpoint.hostName,
 * });
 * ```
 *
 * ### Apex Domains
 * The zone apex cannot hold a CNAME. Point it at the endpoint with an
 * alias `A` record set, and publish the token at `_dnsauth`.
 *
 * **Example:** `contoso.com` on Front Door
 * ```typescript
 * const apex = yield* Azure.Cdn.AfdCustomDomain("apex", {
 *   profile: profile.profileName,
 *   hostName: "contoso.com",
 *   azureDnsZoneId: zone.zoneId,
 * });
 * yield* Azure.Dns.RecordSet("apex-dnsauth", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "_dnsauth",
 *   txtRecords: [apex.validationToken.as<string>()],
 * });
 * yield* Azure.Dns.RecordSet("apex", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "@",
 *   targetResourceId: endpoint.endpointId,
 * });
 * ```
 *
 * ### TLS Settings
 * Pick a predefined cipher suite set, or `Customized` with a minimum TLS
 * version.
 *
 * **Example:** TLS 1.2 with the 2023 cipher suites
 * ```typescript
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.example.com",
 *   tlsSettings: { certificateType: "ManagedCertificate", cipherSuiteSetType: "TLS12_2023" },
 * });
 * ```
 *
 * ### Bring Your Own Certificate
 * Store the certificate in Key Vault, reference it with an
 * `Azure.Cdn.Secret`, and set `certificateType: "CustomerCertificate"`.
 * The profile's identity needs read access to the vault.
 *
 * **Example:** Key Vault certificate for a wildcard domain
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const vault = yield* Azure.KeyVault.Vault("certs");
 * const cert = yield* Azure.Cdn.Secret("wildcard", {
 *   profile: profile.profileName,
 *   parameters: {
 *     type: "CustomerCertificate",
 *     secretSourceId: Output.interpolate`${vault.vaultId}/secrets/wildcard-example-com`,
 *     useLatestVersion: true,
 *   },
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("wildcard", {
 *   profile: profile.profileName,
 *   hostName: "*.example.com",
 *   tlsSettings: { certificateType: "CustomerCertificate", secretId: cert.secretId },
 * });
 * ```
 *
 * ### Mutual TLS
 * Set `mtlsScenario` to require client certificates. Pair it with
 * `enforceMtls: "Enabled"` on the endpoint so no route serves the domain
 * without mTLS.
 *
 * **Example:** Client certificates validated by the origin
 * ```typescript
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("partners", {
 *   profile: profile.profileName,
 *   enforceMtls: "Enabled",
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("partners", {
 *   profile: profile.profileName,
 *   hostName: "partners.example.com",
 *   mtlsScenario: "ClientCertificateRequiredAndOriginValidates",
 * });
 * ```
 *
 * ### Web Application Firewall
 * Protect the domain by listing `customDomainId` in a security policy.
 *
 * **Example:** WAF on the custom domain and the endpoint
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf");
 * yield* Azure.Cdn.SecurityPolicy("waf", {
 *   profile: profile.profileName,
 *   wafPolicyId: waf.policyId,
 *   associations: [{ domainIds: [domain.customDomainId, endpoint.endpointId] }],
 * });
 * ```
 *
 * @resource
 */
export const AfdCustomDomain = GroupedResource<AfdCustomDomain>("Azure.Cdn.AfdCustomDomain");

/**
 * Front Door locks a custom domain while its ownership validation is
 * `Submitting` or `Pending` (until the `_dnsauth` TXT record is published or
 * the token expires): every update is rejected with `Conflict`.
 */
export class AfdCustomDomainValidationPending extends Data.TaggedError(
  "Azure.Cdn.AfdCustomDomainValidationPending",
)<{
  readonly customDomain: string;
  readonly hostName: string;
  readonly domainValidationState: string;
  readonly message: string;
}> {}

const VALIDATION_LOCKED_STATES = ["Submitting", "Pending"];

const createDomainName = (id: string) => createAfdName(id, 50);

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  customDomainName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetAFDCustomDomain({
      subscriptionId,
      resourceGroupName,
      profileName,
      customDomainName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  domain: cdn.GetAFDCustomDomainResponse,
): AfdCustomDomain["Attributes"] => ({
  customDomainName: name,
  customDomainId: domain.id ?? "",
  profile,
  resourceGroup,
  hostName: domain.properties?.hostName ?? "",
  domainValidationState: domain.properties?.domainValidationState,
  validationToken: domain.properties?.validationProperties?.validationToken,
  validationTokenExpiration: domain.properties?.validationProperties?.expirationDate,
  deploymentStatus: domain.properties?.deploymentStatus,
});

const desiredProperties = (news: AfdCustomDomainProps) => {
  const tls = news.tlsSettings ?? {};
  return {
    tlsSettings: {
      certificateType: tls.certificateType ?? "ManagedCertificate",
      minimumTlsVersion: tls.minimumTlsVersion,
      cipherSuiteSetType: tls.cipherSuiteSetType,
      secret: ref(tls.secretId),
    },
    mtlsSettings: news.mtlsScenario === undefined ? undefined : { scenario: news.mtlsScenario },
    azureDnsZone: ref(news.azureDnsZoneId),
    preValidatedCustomDomainResourceId: ref(news.preValidatedCustomDomainResourceId),
  };
};

export const AfdCustomDomainProvider = () =>
  Provider.succeed(AfdCustomDomain, {
    stables: ["customDomainName", "customDomainId", "profile", "resourceGroup", "hostName"],

    // Custom domains are deleted with their profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        !sameName(news.hostName, output.hostName) ||
        (news.name !== undefined && !sameName(news.name, output.customDomainName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      if (resourceGroup === undefined || profile === undefined) return undefined;
      const name = output?.customDomainName ?? olds?.name ?? (yield* createDomainName(id));
      const observed = yield* getDomain(subscriptionId, resourceGroup, profile, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* profileOwnedByStack(subscriptionId, resourceGroup, profile))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name = news.name ?? output?.customDomainName ?? (yield* createDomainName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        customDomainName: name,
      };
      const get = getDomain(subscriptionId, resourceGroup, profile, name);
      const label = `Front Door custom domain ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Ownership validation continues asynchronously; only the
      // ARM provisioning is awaited.
      if (observed === undefined) {
        yield* cdn
          .CreateAFDCustomDomain({
            ...where,
            properties: { ...properties, hostName: news.hostName },
          })
          .pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(label, get, (d) => d.properties?.provisioningState);

      // Sync TLS, mTLS, and DNS-zone settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        const state = observed.properties?.domainValidationState;
        const lockedState =
          state !== undefined && VALIDATION_LOCKED_STATES.includes(state) ? state : undefined;
        const token =
          observed.properties?.validationProperties?.validationToken ?? "<validationToken>";
        yield* cdn.UpdateAFDCustomDomain({ ...where, properties: changed }).pipe(
          Effect.retry(
            lockedState !== undefined
              ? {
                  while: (e) => e._tag === "ResourceConflict",
                  schedule: Schedule.spaced("10 seconds"),
                  times: 6,
                }
              : whileProfileBusy,
          ),
          Effect.catchTag("ResourceConflict", (e) =>
            lockedState !== undefined
              ? Effect.fail<AfdCustomDomainValidationPending | typeof e>(
                  new AfdCustomDomainValidationPending({
                    customDomain: name,
                    hostName: news.hostName,
                    domainValidationState: lockedState,
                    message: `Front Door custom domain ${news.hostName} cannot be updated while its validation is ${lockedState}: publish the TXT record _dnsauth.${news.hostName} = ${token} first.`,
                  }),
                )
              : Effect.fail(e),
          ),
        );
        observed = yield* waitForAfd(label, get, (d) => d.properties?.provisioningState);
      }

      return toAttrs(resourceGroup, profile, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteAFDCustomDomain({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            customDomainName: output.customDomainName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door custom domain ${output.customDomainName}`,
        getDomain(subscriptionId, output.resourceGroup, output.profile, output.customDomainName),
        AFD_DELETE_BUDGET,
      );
    }),
  });
