import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as crypto from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createCertificateName,
  provisioningServiceOwnedByStage,
  retryWhileTransitioning,
  sameName,
} from "./Common.ts";

export interface ProvisioningServiceCertificateProps {
  /** Resource group of the provisioning service. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the provisioning service. Changing it replaces the certificate. */
  provisioningService: string;
  /**
   * Certificate name: letters, digits, periods, hyphens, and underscores
   * (up to 64). If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * The X.509 CA certificate: PEM text (`-----BEGIN CERTIFICATE-----…`) or
   * base64-encoded DER. Public certificate only — never a private key.
   * Updated in place.
   */
  certificate: string;
  /**
   * Mark the certificate as verified, skipping the proof-of-possession
   * challenge. Updated in place.
   * @default false
   */
  isVerified?: boolean;
}

export interface ProvisioningServiceCertificate extends Resource<
  "Azure.IoT.ProvisioningServiceCertificate",
  ProvisioningServiceCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Provisioning service of the certificate. */
    provisioningService: string;
    /** Resource group of the provisioning service. */
    resourceGroup: string;
    /** Subject name of the certificate. */
    subject: string | undefined;
    /** Expiry date and time. */
    expiry: string | undefined;
    /** SHA-1 thumbprint (uppercase hex). */
    thumbprint: string | undefined;
    /** Whether the certificate is verified. */
    isVerified: boolean;
    /** Upload date and time. */
    created: string | undefined;
    /** Last update date and time. */
    updated: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An X.509 CA certificate registered on a Device Provisioning Service.
 * Enrollment groups can then trust devices whose certificates chain to a
 * verified CA.
 *
 * Certificates carry no tags; they count as owned when the parent service
 * carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/iot-dps/concepts-x509-attestation
 *
 * ### Registering a CA Certificate
 * **Example:** Upload a pre-verified root CA
 * ```typescript
 * const dps = yield* Azure.IoT.ProvisioningService("dps", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const ca = yield* Azure.IoT.ProvisioningServiceCertificate("root-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   provisioningService: dps.provisioningServiceName,
 *   certificate: rootCaPem,
 *   isVerified: true,
 * });
 * ```
 *
 * **Example:** Upload an unverified CA (prove possession later)
 * ```typescript
 * const ca = yield* Azure.IoT.ProvisioningServiceCertificate("root-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   provisioningService: dps.provisioningServiceName,
 *   certificate: rootCaPem,
 * });
 * ```
 *
 * @resource
 */
export const ProvisioningServiceCertificate =
  Resource<ProvisioningServiceCertificate>(
    "Azure.IoT.ProvisioningServiceCertificate",
  );

export class InvalidProvisioningServiceCertificate extends Data.TaggedError(
  "Azure.IoT.InvalidProvisioningServiceCertificate",
)<{
  readonly message: string;
}> {}

const toPem = (certificate: string) => {
  const trimmed = certificate.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body =
    trimmed
      .replace(/\s+/g, "")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
};

/** SHA-1 thumbprint of a certificate, uppercase hex, as DPS reports it. */
const thumbprintOf = (certificate: string) =>
  Effect.try({
    try: () =>
      new crypto.X509Certificate(toPem(certificate)).fingerprint
        .replaceAll(":", "")
        .toUpperCase(),
    catch: (cause) =>
      new InvalidProvisioningServiceCertificate({
        message: `DPS certificate is not a valid X.509 certificate: ${String(cause)}`,
      }),
  });

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  provisioningServiceName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    dps.GetDpsCertificate({
      subscriptionId,
      resourceGroupName,
      provisioningServiceName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  provisioningService: string,
  name: string,
  cert: dps.GetDpsCertificateResponse,
): ProvisioningServiceCertificate["Attributes"] => ({
  certificateName: name,
  certificateId: cert.id ?? "",
  provisioningService,
  resourceGroup,
  subject: cert.properties?.subject,
  expiry: cert.properties?.expiry,
  thumbprint: cert.properties?.thumbprint?.toUpperCase(),
  isVerified: cert.properties?.isVerified ?? false,
  created: cert.properties?.created,
  updated: cert.properties?.updated,
});

export const ProvisioningServiceCertificateProvider = () =>
  Provider.succeed(ProvisioningServiceCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "provisioningService",
      "resourceGroup",
    ],

    // Certificates live inside a provisioning service; nuke removes them
    // with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.provisioningService, output.provisioningService) ||
        (news.name !== undefined &&
          !sameName(news.name, output.certificateName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const service = output?.provisioningService ?? olds?.provisioningService;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its service.
      if (resourceGroup === undefined || service === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        service,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, service, name, observed);
      return (yield* provisioningServiceOwnedByStage(
        subscriptionId,
        resourceGroup,
        service,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Devices");
      const { resourceGroup, provisioningService } = news;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const isVerified = news.isVerified ?? false;
      const thumbprint = yield* thumbprintOf(news.certificate);
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        provisioningService,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the certificate content (by thumbprint) and the
      // verified flag are the mutable aspects; an existing certificate is
      // only replaced with its current ETag.
      if (
        observed === undefined ||
        observed.properties?.thumbprint?.toUpperCase() !== thumbprint ||
        (observed.properties?.isVerified ?? false) !== isVerified
      ) {
        yield* retryWhileTransitioning(
          dps.DpsCertificateCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            provisioningServiceName: provisioningService,
            certificateName: name,
            ifMatch: observed?.etag,
            properties: { certificate: toPem(news.certificate), isVerified },
          }),
        );
      }

      const fresh = yield* waitForProvisioned(
        `dps certificate ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, provisioningService, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getCertificate(
        subscriptionId,
        output.resourceGroup,
        output.provisioningService,
        output.certificateName,
      );
      const observed = yield* get;
      if (observed !== undefined) {
        yield* ignoreNotFound(
          retryWhileTransitioning(
            dps.DeleteDpsCertificate({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              provisioningServiceName: output.provisioningService,
              certificateName: output.certificateName,
              ifMatch: observed.etag ?? "*",
            }),
          ),
        );
      }
      yield* waitUntilGone(`dps certificate ${output.certificateName}`, get);
    }),

    nuke: {
      dependsOn: [
        "Azure.IoT.ProvisioningService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
