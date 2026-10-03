import * as iothub from "@distilled.cloud/azure/iothub";
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
import { createChildName, iotHubOwnedByStage } from "./Common.ts";

export interface CertificateProps {
  /** Resource group of the IoT hub. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the IoT hub. Changing it replaces the certificate. */
  iotHub: string;
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

export interface Certificate extends Resource<
  "Azure.IoTHub.Certificate",
  CertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** IoT hub of the certificate. */
    iotHub: string;
    /** Resource group of the IoT hub. */
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
 * An X.509 CA certificate registered on an IoT hub. Devices presenting a
 * certificate signed by a verified CA can authenticate without per-device
 * secrets.
 *
 * Certificates carry no tags or metadata; they count as owned when the
 * parent hub carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/iot-hub/authenticate-authorize-x509
 *
 * ### Registering a CA Certificate
 * **Example:** Upload a pre-verified root CA
 * ```typescript
 * const hub = yield* Azure.IoTHub.IotHub("devices", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const ca = yield* Azure.IoTHub.Certificate("root-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   iotHub: hub.iotHubName,
 *   certificate: rootCaPem,
 *   isVerified: true,
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>("Azure.IoTHub.Certificate");

export class InvalidCertificate extends Data.TaggedError(
  "Azure.IoTHub.InvalidCertificate",
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

/** SHA-1 thumbprint of a certificate, uppercase hex, as IoT Hub reports it. */
const thumbprintOf = (certificate: string) =>
  Effect.try({
    try: () =>
      new crypto.X509Certificate(toPem(certificate)).fingerprint
        .replaceAll(":", "")
        .toUpperCase(),
    catch: (cause) =>
      new InvalidCertificate({
        message: `IoT Hub certificate is not a valid X.509 certificate: ${String(cause)}`,
      }),
  });

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    iothub.GetCertificate({
      subscriptionId,
      resourceGroupName,
      resourceName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  iotHub: string,
  name: string,
  cert: iothub.CertificateDescription,
): Certificate["Attributes"] => ({
  certificateName: name,
  certificateId: cert.id ?? "",
  iotHub,
  resourceGroup,
  subject: cert.properties?.subject,
  expiry: cert.properties?.expiry,
  thumbprint: cert.properties?.thumbprint?.toUpperCase(),
  isVerified: cert.properties?.isVerified ?? false,
  created: cert.properties?.created,
  updated: cert.properties?.updated,
});

const lower = (value: string | undefined) => value?.toLowerCase();

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["certificateName", "certificateId", "iotHub", "resourceGroup"],

    // Certificates live inside a hub; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.iotHub) !== lower(output.iotHub) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.certificateName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const iotHub = output?.iotHub ?? olds?.iotHub;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its hub.
      if (resourceGroup === undefined || iotHub === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createChildName(id, 64));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        iotHub,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, iotHub, name, observed);
      return (yield* iotHubOwnedByStage(subscriptionId, resourceGroup, iotHub))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Devices");
      const { resourceGroup, iotHub } = news;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createChildName(id, 64));
      const isVerified = news.isVerified ?? false;
      const thumbprint = yield* thumbprintOf(news.certificate);
      const get = getCertificate(subscriptionId, resourceGroup, iotHub, name);

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
        yield* iothub.CertificatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: iotHub,
          certificateName: name,
          ifMatch: observed?.etag,
          properties: { certificate: toPem(news.certificate), isVerified },
        });
      }

      const fresh = yield* waitForProvisioned(
        `iot hub certificate ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, iotHub, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getCertificate(
        subscriptionId,
        output.resourceGroup,
        output.iotHub,
        output.certificateName,
      );
      const observed = yield* get;
      if (observed !== undefined) {
        yield* ignoreNotFound(
          iothub.DeleteCertificate({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.iotHub,
            certificateName: output.certificateName,
            ifMatch: observed.etag ?? "*",
          }),
        );
      }
      yield* waitUntilGone(
        `iot hub certificate ${output.certificateName}`,
        get,
      );
    }),

    nuke: {
      dependsOn: ["Azure.IoTHub.IotHub", "Azure.Resources.ResourceGroup"],
    },
  });
