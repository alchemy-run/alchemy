import * as organizations from "@distilled.cloud/daytona/organizations";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { declarable } from "./internal/Declared.ts";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import {
  currentOrganizationId,
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { RoleRef } from "./OrganizationInvitation.ts";
import type { Providers } from "./Providers.ts";

export interface IdentityProviderProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /** Display name. If omitted, generated from the stack, stage and logical ID. */
  name?: string;
  /** OIDC issuer URL. */
  issuerUrl: string;
  /** OIDC client ID. */
  clientId: string;
  /** OIDC client secret. Updated in place. */
  clientSecret: string | Redacted.Redacted<string>;
  /** Scopes to request. @default "openid email profile" */
  scope?: string;
  /** Email domains that sign in through this provider. */
  emailDomains: string[];
  /** Accept any email domain. @default false */
  allowAnyDomain?: boolean;
  /** Trust the provider's `email_verified` claim. @default false */
  trustEmailVerified?: boolean;
  /** Custom roles new members get. */
  defaultRoles?: Ref<RoleRef>[];
  /** Whether sign-in through it is enabled. @default true */
  enabled?: boolean;
}

export interface IdentityProviderAttributes {
  /** Identity provider ID. */
  identityProviderId: string;
  /** Organization ID. */
  organizationId: string;
  /** Display name. */
  name: string;
  /** Email domains. */
  emailDomains: string[];
  /** Whether it is enabled. */
  enabled: boolean;
}

export type IdentityProvider = Resource<
  "Daytona.IdentityProvider",
  IdentityProviderProps,
  IdentityProviderAttributes,
  never,
  Providers
>;

/**
 * An OIDC identity provider for single sign-on into the Daytona
 * organization. Needs an organization with SSO enabled (an enterprise
 * plan); other organizations reject it.
 *
 * ### Single Sign-On
 * **Example:** Sign in with your company's OIDC provider
 * ```typescript
 * export const Sso = Daytona.IdentityProvider("Sso", {
 *   issuerUrl: "https://login.example.com",
 *   clientId: "daytona",
 *   clientSecret: Config.Redacted("OIDC_CLIENT_SECRET"),
 *   emailDomains: ["example.com"],
 *   defaultRoles: [Developer],
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const IdentityProvider = declarable<IdentityProvider>()(
  Resource<IdentityProvider>("Daytona.IdentityProvider"),
);

const toAttributes = (
  organizationId: string,
  p: { id: string; name: string; emailDomains: string[]; enabled: boolean },
): IdentityProviderAttributes => ({
  identityProviderId: p.id,
  organizationId,
  name: p.name,
  emailDomains: p.emailDomains,
  enabled: p.enabled,
});

const roleIds = (roles: IdentityProviderProps["defaultRoles"]) =>
  Effect.succeed((roles ?? []).map((r) => resolved(r).roleId));

export const IdentityProviderProvider = () =>
  Provider.effect(
    IdentityProvider,
    Effect.succeed({
      stables: ["identityProviderId", "organizationId"],
      list: Effect.fn(function* () {
        const organizationId = yield* currentOrganizationId;
        const all = yield* organizations.listOrganizationIdentityProviders({ organizationId });
        return all.map((p) => toAttributes(organizationId, p));
      }),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const name = yield* resolveName(id, olds?.name, output?.name);
        const all = yield* organizations.listOrganizationIdentityProviders({ organizationId });
        const found =
          all.find((p) => p.id === output?.identityProviderId) ?? all.find((p) => p.name === name);
        if (found === undefined) return undefined;
        const attrs = toAttributes(organizationId, found);
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        const name = yield* resolveName(id, news.name, output?.name);
        const desired = {
          name,
          emailDomains: news.emailDomains,
          allowAnyDomain: news.allowAnyDomain ?? false,
          trustEmailVerified: news.trustEmailVerified ?? false,
          defaultAssignedRoleIds: yield* roleIds(news.defaultRoles),
          enabled: news.enabled ?? true,
        };
        const oidcConfig = {
          issuerUrl: news.issuerUrl,
          clientId: news.clientId,
          clientSecret: news.clientSecret,
          scope: news.scope,
        };
        // Observe
        const all = yield* organizations.listOrganizationIdentityProviders({ organizationId });
        const current =
          all.find((p) => p.id === output?.identityProviderId) ?? all.find((p) => p.name === name);
        // Ensure
        if (current === undefined) {
          const created = yield* organizations.createOrganizationIdentityProvider({
            organizationId,
            oidcConfig,
            ...desired,
          });
          return toAttributes(organizationId, created);
        }
        // Sync — the client secret can't be read back, so the full
        // configuration is written on every deploy.
        const updated = yield* organizations.updateOrganizationIdentityProvider({
          organizationId,
          id: current.id,
          oidcConfig,
          ...desired,
        });
        return toAttributes(organizationId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteOrganizationIdentityProvider({
            organizationId: output.organizationId,
            id: output.identityProviderId,
          })
          .pipe(Effect.catchTag("IdentityProviderNotFound", () => Effect.void));
      }),
    }),
  );
