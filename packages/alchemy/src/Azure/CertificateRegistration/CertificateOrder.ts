import * as certificateregistration from "@distilled.cloud/azure/certificateregistration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

/** App Service Certificate product. */
export type CertificateOrderProductType =
  | "StandardDomainValidatedSsl"
  | "StandardDomainValidatedWildCardSsl";

export interface CertificateOrderProps {
  /**
   * Resource group the order is created in. Changing it replaces the
   * order (and cancels the purchased certificate).
   */
  resourceGroup: string;
  /**
   * Name of the certificate order, up to 30 letters, digits, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the order.
   */
  name?: string;
  /**
   * Location of the order. App Service Certificate orders are global
   * resources. Changing it replaces the order.
   * @default "global"
   */
  location?: string;
  /**
   * Certificate product: a single-domain (`StandardDomainValidatedSsl`) or
   * wildcard (`StandardDomainValidatedWildCardSsl`) domain-validated
   * certificate. Changing it replaces the order.
   */
  productType: CertificateOrderProductType;
  /**
   * Certificate distinguished name, e.g. `CN=www.example.com` (or
   * `CN=*.example.com` for a wildcard). Changing it replaces the order.
   */
  distinguishedName?: string;
  /**
   * Validity of the certificate in years. Azure only accepts `1`. Changing
   * it replaces the order.
   * @default 1
   */
  validityInYears?: number;
  /**
   * Certificate key size in bits. Changing it replaces the order.
   * @default 2048
   */
  keySize?: number;
  /**
   * Certificate signing request to use instead of an Azure-generated key.
   * Changing it replaces the order.
   */
  csr?: string;
  /**
   * Whether Azure renews the certificate automatically before it expires.
   * Updated in place. When omitted, Azure's current setting is left alone.
   * @default true (Azure default)
   */
  autoRenew?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CertificateOrder extends Resource<
  "Azure.CertificateRegistration.CertificateOrder",
  CertificateOrderProps,
  {
    /** Name of the certificate order. */
    certificateOrderName: string;
    /** Resource group that holds the order. */
    resourceGroup: string;
    /** ARM resource ID of the order. */
    certificateOrderId: string;
    /** Location of the order (`global`). */
    location: string;
    /** Certificate product type. */
    productType: string;
    /** Certificate distinguished name. */
    distinguishedName: string | undefined;
    /** Certificate key size in bits. */
    keySize: number | undefined;
    /** Validity in years. */
    validityInYears: number | undefined;
    /** Whether the certificate renews automatically. */
    autoRenew: boolean | undefined;
    /**
     * Token to publish (as a TXT record or web page) to prove ownership of
     * the domain before the certificate is issued.
     */
    domainVerificationToken: string | undefined;
    /** Current order status, e.g. `Pendingissuance` or `Issued`. */
    status: string | undefined;
    /** Provisioning state of the order. */
    provisioningState: string | undefined;
    /** Serial number of the issued certificate. */
    serialNumber: string | undefined;
    /** Expiration time of the issued certificate. */
    expirationTime: string | undefined;
    /** Thumbprint of the issued certificate. */
    thumbprint: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An App Service Certificate order — a domain-validated TLS certificate
 * purchased through Azure (issued by GoDaddy) that can be stored in Key
 * Vault and bound to App Service apps.
 *
 * Creating an order is a real, up-front purchase (~$69.99/year standard,
 * ~$299.99/year wildcard). Deleting the order cancels it; refunds are only
 * possible within the cancellation window. Free-trial subscriptions cannot
 * purchase App Service certificates.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-app-service-certificate
 *
 * ### Ordering a Certificate
 * **Example:** Single-domain certificate
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("certs");
 * const order = yield* Azure.CertificateRegistration.CertificateOrder("www", {
 *   resourceGroup: group.resourceGroupName,
 *   productType: "StandardDomainValidatedSsl",
 *   distinguishedName: "CN=www.example.com",
 *   autoRenew: true,
 * });
 * ```
 *
 * **Example:** Wildcard certificate
 * ```typescript
 * const order = yield* Azure.CertificateRegistration.CertificateOrder("wildcard", {
 *   resourceGroup: group.resourceGroupName,
 *   productType: "StandardDomainValidatedWildCardSsl",
 *   distinguishedName: "CN=*.example.com",
 * });
 * ```
 *
 * ### Verifying the Domain
 * **Example:** Publish the domain verification token as a TXT record
 * ```typescript
 * yield* Azure.Dns.RecordSet("asuid", {
 *   resourceGroup: group.resourceGroupName,
 *   zoneName: zone.zoneName,
 *   name: "@",
 *   recordType: "TXT",
 *   txtRecords: [order.domainVerificationToken],
 * });
 * ```
 *
 * @resource
 */
export const CertificateOrder = Resource<CertificateOrder>(
  "Azure.CertificateRegistration.CertificateOrder",
);

type ObservedOrder =
  certificateregistration.GetAppServiceCertificateOrderResponse;

const getOrder = (
  subscriptionId: string,
  resourceGroupName: string,
  certificateOrderName: string,
) =>
  orUndefinedIfNotFound(
    certificateregistration.GetAppServiceCertificateOrder({
      subscriptionId,
      resourceGroupName,
      certificateOrderName,
    }),
  );

const createOrderName = (id: string) =>
  createPhysicalName({ id, maxLength: 30, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  name: string,
  order: ObservedOrder,
): CertificateOrder["Attributes"] => ({
  certificateOrderName: name,
  resourceGroup,
  certificateOrderId: order.id ?? "",
  location: order.location,
  productType: order.properties?.productType ?? "",
  distinguishedName: order.properties?.distinguishedName,
  keySize: order.properties?.keySize,
  validityInYears: order.properties?.validityInYears,
  autoRenew: order.properties?.autoRenew,
  domainVerificationToken: order.properties?.domainVerificationToken,
  status: order.properties?.status,
  provisioningState: order.properties?.provisioningState,
  serialNumber: order.properties?.serialNumber,
  expirationTime: order.properties?.expirationTime,
  thumbprint: order.properties?.signedCertificate?.thumbprint,
  tags: userTags(order.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

export const CertificateOrderProvider = () =>
  Provider.succeed(CertificateOrder, {
    stables: [
      "certificateOrderName",
      "resourceGroup",
      "certificateOrderId",
      "location",
      "productType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* certificateregistration
        .ListAppServiceCertificateOrders({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAppServiceCertificateOrders", page),
          ),
        );
      return (page.value ?? []).flatMap((order) => {
        const group = resourceGroupOf(order.id);
        return hasAnyAlchemyTag(order.tags) &&
          group !== undefined &&
          order.name !== undefined
          ? [toAttrs(group, order.name, order)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.certificateOrderName)) ||
        lower(news.location ?? "global") !== lower(output.location) ||
        news.productType !== output.productType ||
        (news.distinguishedName !== undefined &&
          news.distinguishedName !== output.distinguishedName) ||
        (news.keySize !== undefined && news.keySize !== output.keySize) ||
        (news.validityInYears !== undefined &&
          news.validityInYears !== output.validityInYears) ||
        news.csr !== olds?.csr
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
        output?.certificateOrderName ??
        olds?.name ??
        (yield* createOrderName(id));
      const observed = yield* getOrder(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.CertificateRegistration",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.certificateOrderName ??
        (yield* createOrderName(id));
      const tags = yield* desiredTags(id, news.tags);
      const target = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        certificateOrderName: name,
      };
      const get = getOrder(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `certificate order ${name}`,
        get,
        (order) => order.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure: placing the order purchases the certificate.
      if (observed === undefined) {
        yield* certificateregistration.AppServiceCertificateOrdersCreateOrUpdate(
          {
            ...target,
            location: news.location ?? "global",
            tags,
            properties: {
              productType: news.productType,
              distinguishedName: news.distinguishedName,
              validityInYears: news.validityInYears ?? 1,
              keySize: news.keySize ?? 2048,
              csr: news.csr,
              autoRenew: news.autoRenew,
            },
          },
        );
        observed = yield* waitReady;
      }

      // Sync auto-renew against the observed order.
      if (
        news.autoRenew !== undefined &&
        observed.properties?.autoRenew !== news.autoRenew
      ) {
        yield* certificateregistration.UpdateAppServiceCertificateOrder({
          ...target,
          properties: {
            productType: observed.properties?.productType ?? news.productType,
            autoRenew: news.autoRenew,
          },
        });
        observed = yield* waitReady;
      }

      // Sync tags: the PATCH body carries no tags, so re-PUT the observed
      // order with the desired tags.
      if (tagsDiffer(observed.tags, tags)) {
        const props = observed.properties;
        yield* certificateregistration.AppServiceCertificateOrdersCreateOrUpdate(
          {
            ...target,
            location: observed.location,
            tags,
            properties: {
              productType: props?.productType ?? news.productType,
              distinguishedName: props?.distinguishedName,
              validityInYears: props?.validityInYears,
              keySize: props?.keySize,
              autoRenew: props?.autoRenew,
            },
          },
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        certificateregistration.DeleteAppServiceCertificateOrder({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          certificateOrderName: output.certificateOrderName,
        }),
      );
      yield* waitUntilGone(
        `certificate order ${output.certificateOrderName}`,
        getOrder(
          subscriptionId,
          output.resourceGroup,
          output.certificateOrderName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
