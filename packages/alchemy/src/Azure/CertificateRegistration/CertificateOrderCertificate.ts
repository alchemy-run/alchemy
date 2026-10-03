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

export interface CertificateOrderCertificateProps {
  /**
   * Resource group of the certificate order. Changing it replaces the
   * certificate.
   */
  resourceGroup: string;
  /**
   * Name of the parent App Service Certificate order. Changing it replaces
   * the certificate.
   */
  certificateOrder: string;
  /**
   * Name of the certificate within the order, up to 64 letters, digits,
   * and `-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Location of the certificate. Certificate orders are global resources.
   * Changing it replaces the certificate.
   * @default "global"
   */
  location?: string;
  /**
   * ARM resource ID of the Key Vault that stores the issued certificate.
   * The `Microsoft.Azure.CertificateRegistration` service principal needs
   * secret get/set access to it. Updated in place.
   */
  keyVaultId: string;
  /**
   * Name of the Key Vault secret that holds the certificate (PFX).
   * Updated in place.
   */
  keyVaultSecretName: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CertificateOrderCertificate extends Resource<
  "Azure.CertificateRegistration.CertificateOrderCertificate",
  CertificateOrderCertificateProps,
  {
    /** Name of the certificate within the order. */
    certificateName: string;
    /** Name of the parent certificate order. */
    certificateOrderName: string;
    /** Resource group of the certificate order. */
    resourceGroup: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Location of the certificate (`global`). */
    location: string;
    /** ARM resource ID of the Key Vault that stores the certificate. */
    keyVaultId: string | undefined;
    /** Name of the Key Vault secret that holds the certificate. */
    keyVaultSecretName: string | undefined;
    /**
     * Status of the Key Vault secret, e.g. `Succeeded` or
     * `WaitingOnCertificateOrder` while the order awaits issuance.
     */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Links an App Service Certificate order to a Key Vault secret, so the
 * issued certificate is stored (and renewed) in your vault and can be
 * imported into App Service apps.
 *
 * Grant the `Microsoft.Azure.CertificateRegistration` service principal
 * secret get/set access on the vault first, otherwise the certificate
 * reports `AzureServiceUnauthorizedToAccessKeyVault`.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-app-service-certificate#store-certificate-in-azure-key-vault
 *
 * ### Storing a Certificate in Key Vault
 * **Example:** Store the issued certificate in a vault
 * ```typescript
 * const order = yield* Azure.CertificateRegistration.CertificateOrder("www", {
 *   resourceGroup: group.resourceGroupName,
 *   productType: "StandardDomainValidatedSsl",
 *   distinguishedName: "CN=www.example.com",
 * });
 * const vault = yield* Azure.KeyVault.Vault("certs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const certificate = yield* Azure.CertificateRegistration.CertificateOrderCertificate(
 *   "www-cert",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     certificateOrder: order.certificateOrderName,
 *     keyVaultId: vault.vaultId,
 *     keyVaultSecretName: "www-example-com",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const CertificateOrderCertificate =
  Resource<CertificateOrderCertificate>(
    "Azure.CertificateRegistration.CertificateOrderCertificate",
  );

type ObservedCertificate =
  certificateregistration.GetAppServiceCertificateOrderCertificateResponse;

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  certificateOrderName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    certificateregistration.GetAppServiceCertificateOrderCertificate({
      subscriptionId,
      resourceGroupName,
      certificateOrderName,
      name,
    }),
  );

const createCertificateName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  certificateOrderName: string,
  name: string,
  certificate: ObservedCertificate,
): CertificateOrderCertificate["Attributes"] => ({
  certificateName: name,
  certificateOrderName,
  resourceGroup,
  certificateId: certificate.id ?? "",
  location: certificate.location,
  keyVaultId: certificate.properties?.keyVaultId,
  keyVaultSecretName: certificate.properties?.keyVaultSecretName,
  provisioningState: certificate.properties?.provisioningState,
  tags: userTags(certificate.tags),
});

/**
 * Collapse the Key Vault secret status into a provisioning state:
 * `WaitingOnCertificateOrder` is a stable, usable state until the order is
 * issued; vault-access failures are terminal until the user fixes access.
 */
const secretState = (status: string | undefined) => {
  switch (status) {
    case undefined:
    case "Succeeded":
    case "WaitingOnCertificateOrder":
    case "ExternalPrivateKey":
      return "Succeeded";
    case "CertificateOrderFailed":
    case "KeyVaultDoesNotExist":
    case "OperationNotPermittedOnKeyVault":
      return "Failed";
    default:
      return status;
  }
};

const lower = (value: string | undefined) => value?.toLowerCase();

export const CertificateOrderCertificateProvider = () =>
  Provider.succeed(CertificateOrderCertificate, {
    stables: [
      "certificateName",
      "certificateOrderName",
      "resourceGroup",
      "certificateId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const orders = yield* certificateregistration
        .ListAppServiceCertificateOrders({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAppServiceCertificateOrders", page),
          ),
        );
      const owned = (orders.value ?? []).flatMap((order) => {
        const group = resourceGroupOf(order.id);
        return hasAnyAlchemyTag(order.tags) &&
          group !== undefined &&
          order.name !== undefined
          ? [{ group, orderName: order.name }]
          : [];
      });
      const perOrder = yield* Effect.forEach(owned, ({ group, orderName }) =>
        orUndefinedIfNotFound(
          certificateregistration
            .ListAppServiceCertificateOrderCertificates({
              subscriptionId,
              resourceGroupName: group,
              certificateOrderName: orderName,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage(
                  "ListAppServiceCertificateOrderCertificates",
                  page,
                ),
              ),
            ),
        ).pipe(
          Effect.map((page) =>
            (page?.value ?? []).flatMap((certificate) =>
              hasAnyAlchemyTag(certificate.tags) &&
              certificate.name !== undefined
                ? [toAttrs(group, orderName, certificate.name, certificate)]
                : [],
            ),
          ),
        ),
      );
      return perOrder.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.certificateOrder) !== lower(output.certificateOrderName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.certificateName)) ||
        lower(news.location ?? "global") !== lower(output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const orderName = output?.certificateOrderName ?? olds?.certificateOrder;
      if (resourceGroup === undefined || orderName === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        orderName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, orderName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.CertificateRegistration",
      );
      const resourceGroup = news.resourceGroup;
      const orderName = news.certificateOrder;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        orderName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the PUT is an upsert of the vault link and tags, so
      // one write covers a missing certificate, a changed vault/secret, and
      // drifted tags.
      if (
        observed === undefined ||
        lower(observed.properties?.keyVaultId) !== lower(news.keyVaultId) ||
        observed.properties?.keyVaultSecretName !== news.keyVaultSecretName ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* certificateregistration.AppServiceCertificateOrdersCreateOrUpdateCertificate(
          {
            subscriptionId,
            resourceGroupName: resourceGroup,
            certificateOrderName: orderName,
            name,
            location: observed?.location ?? news.location ?? "global",
            tags,
            properties: {
              keyVaultId: news.keyVaultId,
              keyVaultSecretName: news.keyVaultSecretName,
            },
          },
        );
        observed = yield* waitForProvisioned(
          `certificate ${orderName}/${name}`,
          get,
          (certificate) =>
            secretState(certificate.properties?.provisioningState),
          { interval: "5 seconds", times: 36 },
        );
      }

      return toAttrs(resourceGroup, orderName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        certificateregistration.DeleteAppServiceCertificateOrderCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          certificateOrderName: output.certificateOrderName,
          name: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `certificate ${output.certificateOrderName}/${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.certificateOrderName,
          output.certificateName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.CertificateRegistration.CertificateOrder",
      ],
    },
  });
