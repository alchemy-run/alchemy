import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
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
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  listOwnedNamespaces,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

/**
 * Who signs an intermediate certificate authority:
 * - `Microsoft` — a root certificate authority in the same namespace,
 *   given by its ARM resource ID.
 * - `External` — your own PKI. Azure generates a certificate signing
 *   request (`certificateSigningRequest` attribute); the CA stays
 *   `PendingActivation` until the signed chain is activated outside
 *   Alchemy.
 */
export type CertificateAuthorityIssuer =
  | {
      type: "Microsoft";
      /** ARM resource ID of the root certificate authority that signs this one. */
      certificateAuthorityId: string;
    }
  | { type: "External" };

export interface CertificateAuthorityProps {
  /**
   * Resource group of the parent namespace. Changing it replaces the CA.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the parent Device Registry namespace. Changing it replaces the CA. */
  namespace: string;
  /**
   * Certificate authority name: 3-63 letters, digits, and hyphens, starting
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the CA.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the CA. Changing it replaces the CA.
   * @default the parent namespace's location
   */
  location?: string;
  /**
   * `Root` for a self-signed, service-managed root CA; `ICA` for an
   * intermediate CA (requires `issuer`). Changing it replaces the CA.
   * @default "Root"
   */
  type?: "Root" | "ICA";
  /**
   * Key type of the CA certificate. Changing it replaces the CA.
   * @default "ECC"
   */
  keyType?: "ECC";
  /**
   * Issuer of an intermediate CA. Required when `type` is `ICA`, not
   * allowed for `Root`. Changing it replaces the CA.
   * @default unset
   */
  issuer?: CertificateAuthorityIssuer;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
   */
  tags?: Record<string, string>;
}

export interface CertificateAuthority extends Resource<
  "Azure.DeviceRegistry.CertificateAuthority",
  CertificateAuthorityProps,
  {
    /** Name of the CA. */
    certificateAuthorityName: string;
    /** ARM resource ID of the CA. */
    certificateAuthorityId: string;
    /** Name of the parent namespace. */
    namespaceName: string;
    /** Resource group that holds the parent namespace. */
    resourceGroup: string;
    /** Location of the CA. */
    location: string;
    /** Globally unique, immutable ID Azure assigns to the CA. */
    uuid: string | undefined;
    /** `Root` or `ICA`. */
    type: string;
    /** Key type of the CA certificate. */
    keyType: string;
    /** Issuer type of an intermediate CA (`Microsoft` or `External`). */
    issuerType: string | undefined;
    /** ARM ID of the signing root CA (Microsoft-issued intermediates). */
    issuerCertificateAuthorityId: string | undefined;
    /** Certificate signing request in PEM format (externally issued intermediates). */
    certificateSigningRequest: string | undefined;
    /** Thumbprint of the externally signed CA certificate, once activated. */
    thumbprint: string | undefined;
    /** Lifecycle status of an externally issued intermediate (`PendingActivation`, `Active`, …). */
    status: string | undefined;
    /** Subject of the CA certificate. */
    subject: string | undefined;
    /** Start of the certificate validity (ISO 8601). */
    validityNotBefore: string | undefined;
    /** End of the certificate validity (ISO 8601). */
    validityNotAfter: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A certificate authority
 * (`Microsoft.DeviceRegistry/namespaces/certificateAuthorities`) in an
 * Azure Device Registry namespace. Azure manages the CA's keys and issues
 * device certificates from it through certificate policies (see
 * `CertificatePolicy`).
 *
 * Certificate authorities are not served in every region; create the
 * parent namespace in one that serves them (for example `centralus`).
 *
 * @see https://learn.microsoft.com/azure/iot-hub/iot-hub-device-registry-overview
 *
 * :::caution
 * Changing `resourceGroup`, `namespace`, `name`, `location`, `type`,
 * `keyType`, or `issuer` replaces the CA. A replaced CA has new keys:
 * certificates issued by the old one stop chaining to it.
 * :::
 *
 * ### Creating a Certificate Authority
 * **Example:** Service-managed root CA
 * ```typescript
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices");
 * const root = yield* Azure.DeviceRegistry.CertificateAuthority("root", {
 *   namespace: ns.namespaceName,
 * });
 * ```
 *
 * ### Intermediate Certificate Authorities
 * **Example:** Intermediate CA signed by the root
 * ```typescript
 * const ica = yield* Azure.DeviceRegistry.CertificateAuthority("ica", {
 *   namespace: ns.namespaceName,
 *   type: "ICA",
 *   issuer: { type: "Microsoft", certificateAuthorityId: root.certificateAuthorityId },
 * });
 * ```
 *
 * **Example:** Intermediate CA signed by your own PKI
 * ```typescript
 * const ica = yield* Azure.DeviceRegistry.CertificateAuthority("external-ica", {
 *   namespace: ns.namespaceName,
 *   type: "ICA",
 *   issuer: { type: "External" },
 * });
 * // Sign ica.certificateSigningRequest with your PKI, then activate the CA.
 * ```
 *
 * @resource
 */
export const CertificateAuthority = GroupedResource<CertificateAuthority>(
  "Azure.DeviceRegistry.CertificateAuthority",
);

const getCertificateAuthority = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  certificateAuthorityName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetCertificateAuthority({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      certificateAuthorityName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  observed: deviceregistry.GetCertificateAuthorityResponse,
): CertificateAuthority["Attributes"] => {
  const props = observed.properties;
  return {
    certificateAuthorityName: name,
    certificateAuthorityId: observed.id ?? "",
    namespaceName,
    resourceGroup,
    location: observed.location,
    uuid: props?.uuid,
    type: props?.certificateAuthorityType ?? "Root",
    keyType: props?.keyType ?? "ECC",
    issuerType: props?.issuer?.issuerType,
    issuerCertificateAuthorityId: props?.issuer?.certificateAuthorityResourceId,
    certificateSigningRequest: props?.issuer?.certificateSigningRequest,
    thumbprint: props?.issuer?.thumbprint,
    status: props?.issuer?.status,
    subject: props?.subject,
    validityNotBefore: props?.validityNotBefore,
    validityNotAfter: props?.validityNotAfter,
    tags: userTags(observed.tags),
  };
};

const toIssuer = (
  issuer: CertificateAuthorityIssuer | undefined,
): deviceregistry.CertificateAuthorityIssuer | undefined =>
  issuer === undefined
    ? undefined
    : issuer.type === "Microsoft"
      ? { issuerType: "Microsoft", certificateAuthorityResourceId: issuer.certificateAuthorityId }
      : { issuerType: "External" };

export const CertificateAuthorityProvider = () =>
  Provider.succeed(CertificateAuthority, {
    stables: [
      "certificateAuthorityName",
      "certificateAuthorityId",
      "namespaceName",
      "resourceGroup",
      "location",
      "uuid",
      "type",
      "keyType",
      "issuerType",
      "issuerCertificateAuthorityId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const namespaces = yield* listOwnedNamespaces(subscriptionId);
      const all: CertificateAuthority["Attributes"][] = [];
      for (const ns of namespaces) {
        const page = yield* orUndefinedIfNotFound(
          collectAll(deviceregistry.ListCertificateAuthorityByNamespace, {
            subscriptionId,
            resourceGroupName: ns.resourceGroup,
            namespaceName: ns.name,
          }),
        );
        for (const ca of page?.value ?? []) {
          if (hasAnyAlchemyTag(ca.tags) && ca.name !== undefined) {
            all.push(toAttrs(ns.resourceGroup, ns.name, ca.name, ca));
          }
        }
      }
      return all;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const issuer = toIssuer(news.issuer);
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.certificateAuthorityName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        (news.type ?? "Root") !== output.type ||
        (news.keyType ?? "ECC") !== output.keyType ||
        issuer?.issuerType !== output.issuerType ||
        !sameName(issuer?.certificateAuthorityResourceId, output.issuerCertificateAuthorityId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroup === undefined || namespaceName === undefined) {
        return undefined;
      }
      const name =
        output?.certificateAuthorityName ?? olds?.name ?? (yield* createDeviceRegistryName(id));
      const observed = yield* getCertificateAuthority(
        subscriptionId,
        resourceGroup,
        namespaceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespaceName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const resourceGroup = news.resourceGroup;
      const namespaceName = news.namespace;
      const name =
        news.name ?? output?.certificateAuthorityName ?? (yield* createDeviceRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName,
        certificateAuthorityName: name,
      };
      const get = getCertificateAuthority(subscriptionId, resourceGroup, namespaceName, name);
      const label = `device registry certificate authority ${namespaceName}/${name}`;
      const state = (ca: deviceregistry.GetCertificateAuthorityResponse) =>
        ca.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. Type, key type, and issuer are create-only.
      if (observed === undefined) {
        const namespace = yield* orUndefinedIfNotFound(
          deviceregistry.GetNamespace({
            subscriptionId,
            resourceGroupName: resourceGroup,
            namespaceName,
          }),
        );
        const location = news.location ?? output?.location ?? namespace?.location ?? env.location;
        yield* deviceregistry.CertificateAuthoritiesCreateOrReplace({
          ...where,
          location,
          tags,
          properties: {
            certificateAuthorityType: news.type ?? "Root",
            keyType: news.keyType ?? "ECC",
            issuer: toIssuer(news.issuer),
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);

      // Sync tags, the only mutable aspect.
      if (tagsDiffer(observed.tags, tags)) {
        yield* deviceregistry.UpdateCertificateAuthority({ ...where, tags });
        observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);
      }

      return toAttrs(resourceGroup, namespaceName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteCertificateAuthority({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          certificateAuthorityName: output.certificateAuthorityName,
        }),
      );
      yield* waitUntilGone(
        `device registry certificate authority ${output.namespaceName}/${output.certificateAuthorityName}`,
        getCertificateAuthority(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.certificateAuthorityName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DeviceRegistry.Namespace"],
    },
  });
