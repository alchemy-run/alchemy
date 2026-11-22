import * as applications from "@distilled.cloud/microsoft-graph/applications";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { waitForProvisioned } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { deleteUntilGone, orUndefinedIfGone, REPLICATION_LAG } from "./internal.ts";

/** The audience Microsoft Entra ID expects in an exchanged token. */
export const ENTRA_TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";

export interface FederatedIdentityCredentialProps {
  /**
   * Object ID of the application (`app.objectId`), not its client ID.
   * Changing it replaces the credential.
   */
  applicationObjectId: string;
  /**
   * Name of the credential, unique on the application: up to 120 URL-safe
   * characters. If omitted, a name is generated from the app, stage, and
   * logical ID. Changing it replaces the credential.
   */
  name?: string;
  /**
   * Issuer URL of the external identity provider; it must match the `iss`
   * claim of the external token, e.g.
   * `https://token.actions.githubusercontent.com`. Changing it updates the
   * credential in place.
   */
  issuer: string;
  /**
   * Identity of the external workload; it must match the `sub` claim of
   * the external token, e.g. `repo:my-org/my-repo:ref:refs/heads/main`.
   * The issuer and subject pair must be unique on the application.
   * Changing it updates the credential in place.
   */
  subject: string;
  /**
   * Accepted `aud` claim values. Entra accepts exactly one. Changing it
   * updates the credential in place.
   * @default ["api://AzureADTokenExchange"]
   */
  audiences?: string[];
  /**
   * Free-text description (up to 600 characters). Changing it updates the
   * credential in place.
   * @default no description
   */
  description?: string;
}

export interface FederatedIdentityCredential extends Resource<
  "Azure.Entra.FederatedIdentityCredential",
  FederatedIdentityCredentialProps,
  {
    /** ID of the credential. */
    federatedIdentityCredentialId: string;
    /** Object ID of the application that holds the credential. */
    applicationObjectId: string;
    /** Name of the credential. */
    name: string;
    /** Issuer URL. */
    issuer: string;
    /** Subject. */
    subject: string;
    /** Accepted audiences. */
    audiences: string[];
    /** Description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A federated identity credential on a Microsoft Entra ID application
 * (Microsoft Graph `federatedIdentityCredential`): lets a workload outside
 * Azure (GitHub Actions, a Kubernetes service account, another cloud's
 * identity) exchange its own OIDC token for an Entra token of the
 * application, with no secret to store.
 *
 * Entra accepts a token only when its `iss`, `sub`, and `aud` claims match
 * `issuer`, `subject`, and `audiences` exactly; wildcards are not
 * supported. Credentials have no tags. They belong to their application,
 * are addressed by `name`, and are removed with it. To use a user-assigned
 * managed identity instead of an application, see
 * `Azure.ManagedIdentity.FederatedIdentityCredential`.
 *
 * :::caution[Changing `name` or `applicationObjectId` replaces the credential]
 * The issuer and subject pair must be unique on the application, so a
 * renamed credential is deleted before its replacement is created, and
 * sign-ins fail for the few seconds in between. `issuer`, `subject`,
 * `audiences`, and `description` update in place.
 * :::
 *
 * :::caution[One application holds at most 20 federated credentials]
 * Use one credential per branch, environment, or service account, and a
 * second application when you need more than 20.
 * :::
 *
 * @see https://learn.microsoft.com/graph/api/resources/federatedidentitycredential
 *
 * ### Trusting GitHub Actions
 * GitHub's `sub` claim names the repository and what the job runs for: a
 * branch, a tag, an environment, or a pull request.
 *
 * **Example:** Let one branch of a repository sign in as the application
 * ```typescript
 * const app = yield* Azure.Entra.Application("Deployer");
 * yield* Azure.Entra.FederatedIdentityCredential("GitHubMain", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/heads/main",
 * });
 * ```
 *
 * **Example:** Jobs that use the `production` environment
 * ```typescript
 * yield* Azure.Entra.FederatedIdentityCredential("GitHubProduction", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:environment:production",
 * });
 * ```
 *
 * **Example:** Release tags
 * ```typescript
 * yield* Azure.Entra.FederatedIdentityCredential("GitHubRelease", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/tags/v1.0.0",
 *   description: "release v1.0.0",
 * });
 * ```
 *
 * ### Granting the Workload Access
 * The workload gets the roles of the application's service principal.
 *
 * **Example:** A CI deployer with Contributor on one resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const app = yield* Azure.Entra.Application("Deployer");
 * const principal = yield* Azure.Entra.ServicePrincipal("DeployerPrincipal", {
 *   appId: app.appId,
 * });
 * yield* Azure.Entra.FederatedIdentityCredential("GitHubMain", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/heads/main",
 * });
 * yield* Azure.Authorization.RoleAssignment("DeployerContributes", {
 *   scope: group.resourceGroupId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
 *   principalId: principal.objectId,
 *   principalType: "ServicePrincipal",
 * });
 * // azure/login in the workflow takes client-id and tenant-id from these.
 * return { clientId: app.appId, tenantId: app.tenantId };
 * ```
 *
 * ### Trusting a Kubernetes Service Account
 * The subject is `system:serviceaccount:<namespace>:<name>`, and the issuer
 * is the cluster's OIDC issuer URL.
 *
 * **Example:** Workload identity on an AKS cluster
 * ```typescript
 * const cluster = yield* Azure.ContainerService.ManagedCluster("aks", {
 *   oidcIssuerEnabled: true,
 *   workloadIdentityEnabled: true,
 * });
 * const app = yield* Azure.Entra.Application("Api");
 * yield* Azure.Entra.FederatedIdentityCredential("ApiPods", {
 *   applicationObjectId: app.objectId,
 *   issuer: cluster.oidcIssuerUrl.as<string>(),
 *   subject: "system:serviceaccount:default:api",
 *   description: "api pods",
 * });
 * ```
 *
 * **Example:** A cluster outside Azure
 * ```typescript
 * yield* Azure.Entra.FederatedIdentityCredential("OnPremPods", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://oidc.example.com/clusters/prod",
 *   subject: "system:serviceaccount:jobs:importer",
 * });
 * ```
 *
 * ### Trusting Another Cloud
 * **Example:** A Google Cloud service account
 * ```typescript
 * const app = yield* Azure.Entra.Application("GcpImporter");
 * yield* Azure.Entra.FederatedIdentityCredential("GcpImporterSa", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://accounts.google.com",
 *   // the service account's numeric unique ID
 *   subject: "112233445566778899000",
 * });
 * ```
 *
 * ### Custom Audiences
 * **Example:** Accept tokens minted for another audience
 * ```typescript
 * const app = yield* Azure.Entra.Application("Ci");
 * yield* Azure.Entra.FederatedIdentityCredential("GitLabMain", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://gitlab.example.com",
 *   subject: "project_path:my-group/my-project:ref_type:branch:ref:main",
 *   audiences: ["https://gitlab.example.com"],
 * });
 * ```
 *
 * @resource
 */
export const FederatedIdentityCredential = Resource<FederatedIdentityCredential>(
  "Azure.Entra.FederatedIdentityCredential",
);

type ObservedCredential = applications.GetFederatedIdentityCredentialsResponse;

/** A credential by ID or name (Graph accepts either). */
const getCredential = (applicationObjectId: string, idOrName: string) =>
  orUndefinedIfGone(
    applications.getFederatedIdentityCredentials({
      applicationId: applicationObjectId,
      federatedIdentityCredentialId: idOrName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 120 });

const toAttrs = (
  applicationObjectId: string,
  credential: ObservedCredential,
): FederatedIdentityCredential["Attributes"] => ({
  federatedIdentityCredentialId: credential.id ?? "",
  applicationObjectId,
  name: credential.name ?? "",
  issuer: credential.issuer ?? "",
  subject: credential.subject ?? "",
  audiences: credential.audiences ?? [],
  description: credential.description || undefined,
});

export const FederatedIdentityCredentialProvider = () =>
  Provider.succeed(FederatedIdentityCredential, {
    stables: ["federatedIdentityCredentialId", "applicationObjectId", "name"],

    // Credentials are listed through their application, which `list` of
    // `Azure.Entra.Application` already covers; deleting it removes them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined) return undefined;
      if (!("applicationObjectId" in news) || !isResolved(news.applicationObjectId)) {
        return { action: "replace" } as const;
      }
      if (news.applicationObjectId !== output.applicationObjectId) {
        return { action: "replace" } as const;
      }
      // The issuer + subject pair is unique per application, so a renamed
      // credential must go before its successor is created.
      if (!isResolved(news.name)) return { action: "replace", deleteFirst: true } as const;
      const name = news.name ?? (yield* createName(id));
      if (name !== output.name) return { action: "replace", deleteFirst: true } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const applicationObjectId = output?.applicationObjectId ?? olds?.applicationObjectId;
      if (applicationObjectId === undefined) return undefined;
      const name = output?.name ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getCredential(applicationObjectId, name);
      return observed === undefined ? undefined : toAttrs(applicationObjectId, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const applicationObjectId = news.applicationObjectId;
      const name = news.name ?? output?.name ?? (yield* createName(id));
      const desired = {
        issuer: news.issuer,
        subject: news.subject,
        audiences: news.audiences ?? [ENTRA_TOKEN_EXCHANGE_AUDIENCE],
        description: news.description ?? "",
      };

      // Observe by name.
      let observed = yield* getCredential(applicationObjectId, name);

      // Ensure. A brand-new application is not readable on every replica
      // yet; a concurrent create of the same name is a duplicate.
      if (observed === undefined) {
        yield* applications
          .createFederatedIdentityCredentials({
            applicationId: applicationObjectId,
            name,
            ...desired,
          })
          .pipe(
            Effect.retry(REPLICATION_LAG),
            // A renamed predecessor with the same issuer and subject was
            // just deleted; the uniqueness check lags the delete.
            Effect.retry({
              while: (e) => e._tag === "FederatedIdentityCredentialSubjectInUse",
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
            Effect.catchTag(
              ["DuplicatePropertyValue", "MultipleObjectsWithSameKeyValue"],
              () => Effect.void,
            ),
          );
        observed = yield* waitForProvisioned(
          `federated identity credential ${name}`,
          getCredential(applicationObjectId, name),
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the mutable fields against the observed credential.
      const changed: Partial<typeof desired> = {};
      if (observed.issuer !== desired.issuer) changed.issuer = desired.issuer;
      if (observed.subject !== desired.subject) changed.subject = desired.subject;
      if (JSON.stringify(observed.audiences ?? []) !== JSON.stringify(desired.audiences)) {
        changed.audiences = desired.audiences;
      }
      if ((observed.description ?? "") !== desired.description) {
        changed.description = desired.description;
      }
      if (Object.keys(changed).length > 0) {
        yield* applications
          .updateFederatedIdentityCredentials({
            applicationId: applicationObjectId,
            federatedIdentityCredentialId: observed.id ?? name,
            ...changed,
          })
          .pipe(Effect.retry(REPLICATION_LAG));
        observed = { ...observed, ...changed };
      }
      return toAttrs(applicationObjectId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteUntilGone({
        name: `federated identity credential ${output.name}`,
        objectId: output.federatedIdentityCredentialId,
        get: getCredential(output.applicationObjectId, output.federatedIdentityCredentialId),
        remove: applications.deleteFederatedIdentityCredentials({
          applicationId: output.applicationObjectId,
          federatedIdentityCredentialId: output.federatedIdentityCredentialId,
        }),
      });
    }),
  });
