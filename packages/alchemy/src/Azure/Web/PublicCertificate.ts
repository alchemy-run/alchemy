import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, siteWhere } from "./common.ts";

/** Certificate store a public certificate is installed into. */
export type PublicCertificateLocation =
  | "CurrentUserMy"
  | "LocalMachineMy"
  | "Unknown";

export interface PublicCertificateProps {
  /** Resource group of the app. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the Windows web app or function app. Changing it replaces it. */
  siteName: string;
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
   * Certificate store the certificate is loaded into.
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
 * Windows App Service app (`Microsoft.Web/sites/publicCertificates`), e.g. a
 * private CA the app's outbound calls must trust. Requires a Basic or higher
 * plan; load it into the app with the `WEBSITE_LOAD_CERTIFICATES` setting.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-certificate-in-code
 *
 * ### Trusting a Certificate
 * **Example:** Private root CA
 * ```typescript
 * const ca = yield* Azure.Web.PublicCertificate("root-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   blob: rootCaDerBase64,
 *   publicCertificateLocation: "LocalMachineMy",
 * });
 * // ca.thumbprint
 * ```
 *
 * @resource
 */
export const PublicCertificate = Resource<PublicCertificate>(
  "Azure.Web.PublicCertificate",
);

type ObservedCertificate = web.GetWebAppPublicCertificateResponse;

const createCertificateName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getCertificate = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  publicCertificateName: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppPublicCertificate({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      publicCertificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  publicCertificateName: string,
  observed: ObservedCertificate,
): PublicCertificate["Attributes"] => ({
  publicCertificateName,
  publicCertificateId: observed.id ?? "",
  siteName,
  resourceGroup,
  thumbprint: observed.properties?.thumbprint,
  publicCertificateLocation: observed.properties?.publicCertificateLocation,
});

export const PublicCertificateProvider = () =>
  Provider.succeed(PublicCertificate, {
    stables: [
      "publicCertificateName",
      "publicCertificateId",
      "siteName",
      "resourceGroup",
    ],

    // Certificates are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.publicCertificateName)) ||
        (olds !== undefined && news.blob !== olds.blob)
      ) {
        return { action: "replace" } as const;
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
      const name =
        output?.publicCertificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        siteName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, name, observed);
      // Site certificates carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName } = news;
      const name =
        news.name ??
        output?.publicCertificateName ??
        (yield* createCertificateName(id));
      const location = news.publicCertificateLocation ?? "CurrentUserMy";

      // Observe.
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        siteName,
        name,
      );

      const inStore = (cert: ObservedCertificate | undefined) =>
        cert !== undefined &&
        lower(cert.properties?.publicCertificateLocation) === lower(location);
      const put = web.WebAppsCreateOrUpdatePublicCertificate({
        ...siteWhere(subscriptionId, resourceGroup, siteName),
        publicCertificateName: name,
        properties: {
          blob: news.blob,
          publicCertificateLocation: location,
        },
      });

      // Ensure (a synchronous PUT; the blob is immutable).
      if (observed === undefined) {
        return toAttrs(resourceGroup, siteName, name, yield* put);
      }
      if (inStore(observed)) {
        return toAttrs(resourceGroup, siteName, name, observed);
      }

      // Sync the store. Microsoft.Web accepts a PUT on an existing
      // certificate but keeps its original store, so a store change
      // re-installs the certificate under the same name.
      yield* ignoreNotFound(
        web.DeleteWebAppPublicCertificate({
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          publicCertificateName: name,
        }),
      );
      yield* waitUntilGone(
        `public certificate ${name}`,
        getCertificate(subscriptionId, resourceGroup, siteName, name),
      );
      return toAttrs(resourceGroup, siteName, name, yield* put);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppPublicCertificate({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          publicCertificateName: output.publicCertificateName,
        }),
      );
      yield* waitUntilGone(
        `public certificate ${output.publicCertificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.publicCertificateName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
