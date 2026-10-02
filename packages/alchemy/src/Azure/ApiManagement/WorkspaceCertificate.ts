import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Certificate, CertificateProps } from "./Certificate.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export interface WorkspaceCertificateProps extends CertificateProps {
  /** Workspace that holds the certificate (`Workspace.workspaceName`). Changing it replaces the certificate. */
  workspaceName: string;
}

export interface WorkspaceCertificate extends Resource<
  "Azure.ApiManagement.WorkspaceCertificate",
  WorkspaceCertificateProps,
  Certificate["Attributes"] & {
    /** Workspace that holds the certificate. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Certificate}: a certificate inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Certificate} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Certificates
 * **Example:** Upload a PFX
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceCertificate("client-cert", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   data: Redacted.make(pfxBase64),
 *   password: Redacted.make(pfxPassword),
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceCertificate = Resource<WorkspaceCertificate>(
  "Azure.ApiManagement.WorkspaceCertificate",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  certificateName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  certificateId: key.certificateName,
});

export const WorkspaceCertificateProvider = () =>
  Provider.succeed(WorkspaceCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceCertificateProps,
      WorkspaceCertificate["Attributes"],
      Key,
      apim.GetWorkspaceCertificateResponse
    >({
      label: (key) =>
        `API Management workspace certificate ${key.certificateName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            certificateName:
              props.name ??
              output?.certificateName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceCertificate({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceCertificateCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: {
            data: news.keyVault !== undefined ? undefined : reveal(news.data),
            password:
              news.keyVault !== undefined ? undefined : reveal(news.password),
            keyVault: news.keyVault,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceCertificate({
          ...where(subscriptionId, key),
        }),
      // GET exposes only the thumbprint/subject, never the PFX, so the
      // previous props are the baseline for content changes.
      inSync: (news, observed, olds) => {
        const keyVault = observed.properties?.keyVault;
        return (
          olds !== undefined &&
          reveal(olds.data) === reveal(news.data) &&
          reveal(olds.password) === reveal(news.password) &&
          (news.keyVault === undefined
            ? keyVault?.secretIdentifier === undefined
            : keyVault?.secretIdentifier === news.keyVault.secretIdentifier)
        );
      },
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        certificateName: key.certificateName,
        certificateId: observed.id ?? "",
        thumbprint: observed.properties?.thumbprint ?? "",
        subject: observed.properties?.subject ?? "",
        expirationDate: observed.properties?.expirationDate ?? "",
      }),
    }),
  });
