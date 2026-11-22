import * as sql from "@distilled.cloud/azure/sql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createChildName, lower } from "./common.ts";
import { instancePath, type InstanceScope } from "./setting.ts";

export interface ServerTrustCertificateProps {
  /** Resource group of the managed instance. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the certificate. */
  managedInstance: string;
  /**
   * Certificate name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Public certificate as hex-encoded DER, e.g. the output of
   * `openssl x509 -outform DER -in cert.pem | xxd -p | tr -d '\n'`.
   * Changing it replaces the certificate.
   */
  publicBlob: string;
}

export interface ServerTrustCertificate extends Resource<
  "Azure.Sql.ServerTrustCertificate",
  ServerTrustCertificateProps,
  {
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Name of the certificate. */
    certificateName: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Thumbprint of the certificate. */
    thumbprint: string | undefined;
    /** Hex-encoded DER of the certificate. */
    publicBlob: string;
  },
  never,
  Providers
> {}

/**
 * A server trust certificate on an Azure SQL Managed Instance
 * (`Microsoft.Sql/managedInstances/serverTrustCertificates`): the public
 * certificate of a SQL Server the instance trusts, e.g. the endpoint
 * certificate of the SQL Server side of a Managed Instance link.
 *
 * Certificates are immutable: uploading a different certificate replaces
 * the resource.
 *
 * :::caution
 * Changing `resourceGroup`, `managedInstance`, `name`, or `publicBlob`
 * replaces the certificate.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/managed-instance-link-preparation
 *
 * ### Trusting a SQL Server
 * **Example:** Upload the endpoint certificate of a SQL Server
 * ```typescript
 * yield* Azure.Sql.ServerTrustCertificate("onprem-endpoint", {
 *   managedInstance: instance.managedInstanceName,
 *   publicBlob: sqlServerEndpointCertificateHex,
 * });
 * ```
 *
 * @resource
 */
export const ServerTrustCertificate = GroupedResource<ServerTrustCertificate>(
  "Azure.Sql.ServerTrustCertificate",
);

interface CertificateScope extends InstanceScope {
  certificateName: string;
}

const getCertificate = (subscriptionId: string, scope: CertificateScope) =>
  orUndefinedIfNotFound(
    sql.GetServerTrustCertificate({
      ...instancePath(subscriptionId, scope),
      certificateName: scope.certificateName,
    }),
  );

/** Hex DER without an optional `0x` prefix, uppercased. */
const normalizeBlob = (blob: string | undefined) => (blob ?? "").replace(/^0x/i, "").toUpperCase();

const toAttrs = (
  scope: CertificateScope,
  observed: sql.GetServerTrustCertificateResponse,
): ServerTrustCertificate["Attributes"] => ({
  certificateId: observed.id ?? "",
  certificateName: scope.certificateName,
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  thumbprint: observed.properties?.thumbprint,
  publicBlob: normalizeBlob(observed.properties?.publicBlob),
});

export const ServerTrustCertificateProvider = () =>
  Provider.succeed(ServerTrustCertificate, {
    stables: [
      "certificateId",
      "certificateName",
      "resourceGroup",
      "managedInstanceName",
      "thumbprint",
      "publicBlob",
    ],

    // Certificates live inside a managed instance; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        (news.name !== undefined && news.name !== output.certificateName) ||
        normalizeBlob(news.publicBlob) !== output.publicBlob
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName = output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) return undefined;
      const generated = yield* createChildName(id);
      const certificateName = output?.certificateName ?? olds?.name ?? generated;
      const scope = { resourceGroup, managedInstanceName, certificateName };
      const observed = yield* getCertificate(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined || certificateName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: CertificateScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
        certificateName: news.name ?? output?.certificateName ?? (yield* createChildName(id)),
      };
      const get = getCertificate(subscriptionId, scope);

      // A certificate is immutable: observe, upload if missing.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.ServerTrustCertificatesCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          certificateName: scope.certificateName,
          properties: { publicBlob: normalizeBlob(news.publicBlob) },
        });
      }
      // The upload runs asynchronously on the instance.
      const fresh = yield* waitForProvisioned(
        `sql server trust certificate ${scope.certificateName}`,
        get,
        () => undefined,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteServerTrustCertificate({
          ...instancePath(subscriptionId, output),
          certificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `sql server trust certificate ${output.certificateName}`,
        getCertificate(subscriptionId, output),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
