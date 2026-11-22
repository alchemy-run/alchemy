import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, siteWhere } from "./common.ts";

/** Certificate store a public certificate is installed into. */
export type PublicCertificateLocation = "CurrentUserMy" | "LocalMachineMy" | "Unknown";

export interface PublicCertificateProps {
  /** Resource group of the app. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the Windows web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the certificate.
   * @default the production slot
   */
  slot?: string;
  /**
   * Name of the certificate. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Base64-encoded DER (`.cer`) public certificate. Changing it replaces the
   * certificate.
   */
  blob: string;
  /**
   * Certificate store the certificate is loaded into. Outside an App Service
   * Environment Microsoft.Web accepts only `CurrentUserMy`; `LocalMachineMy`
   * is rejected as an invalid value.
   * @default "CurrentUserMy"
   */
  publicCertificateLocation?: PublicCertificateLocation;
}

export interface PublicCertificate extends Resource<
  "Azure.Web.PublicCertificate",
  PublicCertificateProps,
  {
    /** Name of the certificate. */
    publicCertificateName: string;
    /** ARM resource ID of the certificate. */
    publicCertificateId: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** SHA-1 thumbprint of the certificate. */
    thumbprint: string | undefined;
    /** Certificate store the certificate is loaded into. */
    publicCertificateLocation: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A public (`.cer`) certificate loaded into the certificate store of a
 * Windows App Service app (`Microsoft.Web/sites/publicCertificates`, or
 * `sites/slots/publicCertificates` with `slot`), e.g. a
 * private CA the app's outbound calls must trust. Requires a Basic or higher
 * plan; load it into the app with the `WEBSITE_LOAD_CERTIFICATES` setting.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-certificate-in-code
 *
 * ### Trusting a Certificate
 * **Example:** Private root CA
 * ```typescript
 * const ca = yield* Azure.Web.PublicCertificate("root-ca", {
 *   siteName: app.siteName,
 *   blob: rootCaDerBase64,
 * });
 * // ca.thumbprint
 * ```
 *
 * @resource
 */
export const PublicCertificate = GroupedResource<PublicCertificate>("Azure.Web.PublicCertificate");

type ObservedCertificate = web.GetWebAppPublicCertificateResponse;

const createCertificateName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getCertificate = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  publicCertificateName: string,
) => {
  const where = { ...siteWhere(subscriptionId, resourceGroup, siteName), publicCertificateName };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppPublicCertificate(where)
      : web.GetWebAppPublicCertificateSlot({ ...where, slot }),
  );
};

const deleteCertificate = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  publicCertificateName: string,
) => {
  const where = { ...siteWhere(subscriptionId, resourceGroup, siteName), publicCertificateName };
  return ignoreNotFound(
    slot === undefined
      ? web.DeleteWebAppPublicCertificate(where)
      : web.DeleteWebAppPublicCertificateSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  publicCertificateName: string,
  observed: ObservedCertificate,
): PublicCertificate["Attributes"] => ({
  publicCertificateName,
  publicCertificateId: observed.id ?? "",
  siteName,
  slot,
  resourceGroup,
  thumbprint: observed.properties?.thumbprint,
  publicCertificateLocation: observed.properties?.publicCertificateLocation,
});

export const PublicCertificateProvider = () =>
  Provider.succeed(PublicCertificate, {
    stables: ["publicCertificateName", "publicCertificateId", "siteName", "slot", "resourceGroup"],

    // Certificates are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameSite =
        lower(news.resourceGroup) === lower(output.resourceGroup) &&
        lower(news.siteName) === lower(output.siteName) &&
        lower(news.slot) === lower(output.slot);
      const sameBlob = olds === undefined || news.blob === olds.blob;
      if (
        !sameSite ||
        !sameBlob ||
        (news.name !== undefined && lower(news.name) !== lower(output.publicCertificateName))
      ) {
        // An app holds a certificate (thumbprint) once: renaming it on the
        // same app must delete the old one first, or the create fails with
        // "The parameter location,thumbprint has an invalid value."
        return sameSite && sameBlob
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) {
        return undefined;
      }
      const slot = output?.slot ?? olds?.slot;
      const name =
        output?.publicCertificateName ?? olds?.name ?? (yield* createCertificateName(id));
      const observed = yield* getCertificate(subscriptionId, resourceGroup, siteName, slot, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, name, observed);
      // Site certificates carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const name = news.name ?? output?.publicCertificateName ?? (yield* createCertificateName(id));
      const location = news.publicCertificateLocation ?? "CurrentUserMy";

      // Observe.
      const observed = yield* getCertificate(subscriptionId, resourceGroup, siteName, slot, name);

      const inStore = (cert: ObservedCertificate | undefined) =>
        cert !== undefined && lower(cert.properties?.publicCertificateLocation) === lower(location);
      const request = {
        ...siteWhere(subscriptionId, resourceGroup, siteName),
        publicCertificateName: name,
        properties: {
          blob: news.blob,
          publicCertificateLocation: location,
        },
      };
      const put =
        slot === undefined
          ? web.WebAppsCreateOrUpdatePublicCertificate(request)
          : web.WebAppsCreateOrUpdatePublicCertificateSlot({ ...request, slot });

      // Ensure (a synchronous PUT; the blob is immutable).
      if (observed === undefined) {
        const created = yield* put;
        return toAttrs(resourceGroup, siteName, slot, name, created);
      }
      if (inStore(observed)) {
        return toAttrs(resourceGroup, siteName, slot, name, observed);
      }

      // Sync the store. Microsoft.Web accepts a PUT on an existing
      // certificate but keeps its original store, so a store change
      // re-installs the certificate under the same name.
      yield* deleteCertificate(subscriptionId, resourceGroup, siteName, slot, name);
      yield* waitUntilGone(
        `public certificate ${name}`,
        getCertificate(subscriptionId, resourceGroup, siteName, slot, name),
      );
      const reinstalled = yield* put;
      return toAttrs(resourceGroup, siteName, slot, name, reinstalled);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteCertificate(
        subscriptionId,
        output.resourceGroup,
        output.siteName,
        output.slot,
        output.publicCertificateName,
      );
      yield* waitUntilGone(
        `public certificate ${output.publicCertificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.publicCertificateName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
