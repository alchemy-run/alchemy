import * as msi from "@distilled.cloud/azure/msi";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  stackAndStage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Audience Microsoft Entra expects in federated tokens by default. */
export const DEFAULT_FEDERATED_AUDIENCE = "api://AzureADTokenExchange";

export interface FederatedIdentityCredentialProps {
  /**
   * Resource group of the parent user-assigned identity. Changing it
   * replaces the credential.
   */
  resourceGroup: string;
  /**
   * Name of the parent user-assigned identity. Changing it replaces the
   * credential.
   */
  identity: string;
  /**
   * Name of the credential, 3-120 characters of letters, digits, `-`, and
   * `_`, starting with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * credential.
   */
  name?: string;
  /**
   * URL of the external OpenID Connect issuer to trust, e.g.
   * `https://token.actions.githubusercontent.com` or an AKS cluster's OIDC
   * issuer URL.
   */
  issuer: string;
  /**
   * Identifier of the external identity, e.g.
   * `repo:my-org/my-repo:ref:refs/heads/main` (GitHub Actions) or
   * `system:serviceaccount:my-namespace:my-sa` (Kubernetes). The
   * issuer/subject pair must be unique per identity.
   */
  subject: string;
  /**
   * Audience that must appear in the external token. Azure currently
   * accepts exactly one entry.
   * @default ["api://AzureADTokenExchange"]
   */
  audiences?: string[];
}

export interface FederatedIdentityCredential extends Resource<
  "Azure.ManagedIdentity.FederatedIdentityCredential",
  FederatedIdentityCredentialProps,
  {
    /** Name of the credential. */
    credentialName: string;
    /** Name of the parent user-assigned identity. */
    identityName: string;
    /** Resource group of the parent identity. */
    resourceGroup: string;
    /** ARM resource ID of the credential. */
    credentialId: string;
    /** Trusted OpenID Connect issuer URL. */
    issuer: string;
    /** Trusted external subject identifier. */
    subject: string;
    /** Accepted token audiences. */
    audiences: string[];
  },
  never,
  Providers
> {}

/**
 * A federated identity credential on a user-assigned managed identity. It
 * lets an external workload (GitHub Actions, Kubernetes service accounts,
 * another cloud) exchange its OpenID Connect token for a Microsoft Entra
 * token of the identity — no secrets to store or rotate.
 *
 * Federated credentials carry no tags. Alchemy treats one as owned when its
 * parent identity carries this stack's and stage's ownership tags. Deleting
 * the parent identity deletes its credentials.
 *
 * @see https://learn.microsoft.com/entra/workload-id/workload-identity-federation
 *
 * ### Trusting GitHub Actions
 * **Example:** Deploy from the main branch without secrets
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ci");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("deployer", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.ManagedIdentity.FederatedIdentityCredential("github-main", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: identity.identityName,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/heads/main",
 * });
 * ```
 *
 * ### Trusting a Kubernetes Service Account
 * **Example:** AKS workload identity
 * ```typescript
 * yield* Azure.ManagedIdentity.FederatedIdentityCredential("api-sa", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: identity.identityName,
 *   issuer: cluster.oidcIssuerUrl,
 *   subject: "system:serviceaccount:default:api",
 * });
 * ```
 *
 * @resource
 */
export const FederatedIdentityCredential =
  Resource<FederatedIdentityCredential>(
    "Azure.ManagedIdentity.FederatedIdentityCredential",
  );

type ObservedCredential = msi.GetFederatedIdentityCredentialsResponse;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 120 });

const getCredential = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  federatedIdentityCredentialResourceName: string,
) =>
  orUndefinedIfNotFound(
    msi.GetFederatedIdentityCredentials({
      subscriptionId,
      resourceGroupName,
      resourceName,
      federatedIdentityCredentialResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  identityName: string,
  name: string,
  credential: ObservedCredential,
): FederatedIdentityCredential["Attributes"] => ({
  credentialName: name,
  identityName,
  resourceGroup,
  credentialId: credential.id ?? "",
  issuer: credential.properties?.issuer ?? "",
  subject: credential.properties?.subject ?? "",
  audiences: [...(credential.properties?.audiences ?? [])],
});

/** Azure rejects concurrent credential writes on one identity; retry them. */
const retryConcurrentWrite = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "FederatedIdentityCredentialWriteConflict",
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
  );

const sameAudiences = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The parent identity carries this stack's and stage's ownership tags. */
const parentOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  Effect.gen(function* () {
    const identity = yield* orUndefinedIfNotFound(
      msi.GetUserAssignedIdentity({
        subscriptionId,
        resourceGroupName,
        resourceName,
      }),
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      identity?.tags?.["alchemy::stack"] === stack &&
      identity?.tags?.["alchemy::stage"] === stage
    );
  });

export const FederatedIdentityCredentialProvider = () =>
  Provider.succeed(FederatedIdentityCredential, {
    stables: [
      "credentialName",
      "identityName",
      "resourceGroup",
      "credentialId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const identities = yield* msi
        .ListUserAssignedIdentityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListUserAssignedIdentityBySubscription", page),
          ),
        );
      const owned = (identities.value ?? []).flatMap((identity) => {
        const group = resourceGroupOf(identity.id);
        return hasAnyAlchemyTag(identity.tags) &&
          group !== undefined &&
          identity.name !== undefined
          ? [{ group, name: identity.name }]
          : [];
      });
      const nested = yield* Effect.forEach(
        owned,
        ({ group, name }) =>
          orUndefinedIfNotFound(
            msi
              .ListFederatedIdentityCredentials({
                subscriptionId,
                resourceGroupName: group,
                resourceName: name,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListFederatedIdentityCredentials", page),
                ),
              ),
          ).pipe(
            Effect.map((page) =>
              (page?.value ?? []).flatMap((credential) =>
                credential.name !== undefined
                  ? [toAttrs(group, name, credential.name, credential)]
                  : [],
              ),
            ),
          ),
        { concurrency: 4 },
      );
      return nested.flat();
    }),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? (yield* physicalName(id));
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.identity.toLowerCase() !== output.identityName.toLowerCase() ||
        name.toLowerCase() !== output.credentialName.toLowerCase()
      ) {
        // The issuer/subject pair is unique per identity, so a replacement
        // that keeps it must delete the old credential first.
        const samePair =
          news.issuer === output.issuer && news.subject === output.subject;
        return { action: "replace", deleteFirst: samePair } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const identityName = output?.identityName ?? olds?.identity;
      if (resourceGroup === undefined || identityName === undefined) {
        return undefined;
      }
      const name =
        output?.credentialName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getCredential(
        subscriptionId,
        resourceGroup,
        identityName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, identityName, name, observed);
      return (yield* parentOwned(subscriptionId, resourceGroup, identityName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedIdentity");
      const resourceGroup = news.resourceGroup;
      const identityName = news.identity;
      const name =
        news.name ?? output?.credentialName ?? (yield* physicalName(id));
      const desired = {
        issuer: news.issuer,
        subject: news.subject,
        audiences: news.audiences ?? [DEFAULT_FEDERATED_AUDIENCE],
      };

      // Observe.
      let observed: ObservedCredential | undefined = yield* getCredential(
        subscriptionId,
        resourceGroup,
        identityName,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full-body upsert, and
      // issuer/subject/audiences are the only mutable aspects.
      if (
        observed === undefined ||
        observed.properties?.issuer !== desired.issuer ||
        observed.properties?.subject !== desired.subject ||
        !sameAudiences(observed.properties?.audiences ?? [], desired.audiences)
      ) {
        observed = yield* msi
          .FederatedIdentityCredentialsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: identityName,
            federatedIdentityCredentialResourceName: name,
            properties: desired,
          })
          .pipe(retryConcurrentWrite);
      }

      return toAttrs(resourceGroup, identityName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        msi
          .DeleteFederatedIdentityCredentials({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.identityName,
            federatedIdentityCredentialResourceName: output.credentialName,
          })
          .pipe(retryConcurrentWrite),
      );
      yield* waitUntilGone(
        `federated identity credential ${output.credentialName}`,
        getCredential(
          subscriptionId,
          output.resourceGroup,
          output.identityName,
          output.credentialName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedIdentity.UserAssignedIdentity",
      ],
    },
  });
