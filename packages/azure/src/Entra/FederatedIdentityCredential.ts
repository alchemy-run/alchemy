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
   * `https://token.actions.githubusercontent.com`.
   */
  issuer: string;
  /**
   * Identity of the external workload; it must match the `sub` claim of
   * the external token, e.g. `repo:my-org/my-repo:ref:refs/heads/main`.
   */
  subject: string;
  /**
   * Accepted `aud` claim values. Entra accepts exactly one.
   * @default ["api://AzureADTokenExchange"]
   */
  audiences?: string[];
  /** Free-text description (up to 600 characters). */
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
 * A federated identity credential on a Microsoft Entra ID application:
 * lets a workload outside Azure (GitHub Actions, a Kubernetes service
 * account, another cloud's identity) exchange its own OIDC token for an
 * Entra token, with no secret to store.
 *
 * Credentials have no tags. They belong to their application, are
 * addressed by `name`, and are removed with it. The issuer and subject
 * pair must be unique on the application, so renaming a credential deletes
 * it before creating its replacement.
 *
 * @see https://learn.microsoft.com/graph/api/resources/federatedidentitycredential
 *
 * ### Trusting GitHub Actions
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
 * ### Trusting a Kubernetes Service Account
 * **Example:** Workload identity on a cluster with an OIDC issuer
 * ```typescript
 * yield* Azure.Entra.FederatedIdentityCredential("ApiPods", {
 *   applicationObjectId: app.objectId,
 *   issuer: "https://oidc.prod-aks.azure.com/<tenant-id>/<issuer-id>/",
 *   subject: "system:serviceaccount:default:api",
 *   description: "api pods",
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
