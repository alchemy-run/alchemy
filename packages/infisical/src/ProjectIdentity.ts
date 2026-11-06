import * as infisical from "@distilled.cloud/infisical";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { Providers } from "./Providers.ts";

/** OIDC trust and access-token settings for a project machine identity. */
export interface OidcAuth {
  /** URL used to retrieve the identity provider's OpenID configuration. */
  oidcDiscoveryUrl: string;
  /** Identity provider issuer that must match the JWT's issuer. */
  boundIssuer: string;
  /** Intended JWT recipients. @default [] */
  boundAudiences?: readonly string[];
  /** Expected JWT subject; an empty string leaves it unrestricted. @default "" */
  boundSubject?: string;
  /** Claims that the JWT must contain. @default {} */
  boundClaims?: Readonly<Record<string, string>>;
  /** JWT claims to expose as permission metadata. @default {} */
  claimMetadataMapping?: Readonly<Record<string, string>>;
  /** PEM-encoded CA certificate for the identity provider. @default "" */
  caCert?: string;
  /** Access-token lifetime, in seconds. @default 2592000 */
  accessTokenTTL?: number;
  /** Maximum access-token lifetime, in seconds. @default 2592000 */
  accessTokenMaxTTL?: number;
  /** Maximum uses of an access token; zero means unlimited. @default 0 */
  accessTokenNumUsesLimit?: number;
  /** IP addresses or CIDR ranges from which tokens may be used. @default ["0.0.0.0/0", "::/0"] */
  accessTokenTrustedIps?: readonly string[];
}

export interface ProjectIdentityProps {
  /** Project UUID. Changing it replaces the identity. */
  project: string;
  /** Name prefix; the physical name ends with an instance suffix. */
  name: string;
  /** Permanent project role slugs. Roles not declared here are revoked. */
  roles: readonly [string, ...string[]];
  /** OIDC settings. Omitted fields restore Infisical's defaults. */
  oidcAuth: OidcAuth;
}

export interface ProjectIdentityAttributes {
  /** Machine identity ID, used as `INFISICAL_IDENTITY_ID` in CI. */
  id: string;
  /** Project UUID. */
  project: string;
  /** Physical identity name, including its instance suffix. */
  name: string;
  /** Project role slugs, sorted. */
  roles: readonly string[];
  /** OIDC settings with every default filled in. */
  oidcAuth: Required<OidcAuth>;
}

export type ProjectIdentity = Resource<
  "Infisical.ProjectIdentity",
  ProjectIdentityProps,
  ProjectIdentityAttributes,
  never,
  Providers
>;

/**
 * A machine identity confined to one Infisical project, with permanent
 * project roles and OIDC authentication. CI logs in with its platform's OIDC
 * token by setting `INFISICAL_IDENTITY_ID` to this resource's `id`, so no
 * token is created or kept in state. Deleting the identity revokes the tokens
 * it was issued.
 *
 * The deploying identity needs permission to manage machine identities,
 * identity memberships and OIDC auth in the project. Changing `project`
 * replaces the identity; name, roles and OIDC settings update in place.
 *
 * @see https://infisical.com/docs/documentation/platform/identities/oidc-auth
 *
 * ### Creating a CI Identity
 * **Example:** GitHub Actions identity for one repository's main branch
 * ```typescript
 * const ci = yield* Infisical.ProjectIdentity("CI", {
 *   project: "00000000-0000-4000-8000-000000000000",
 *   name: "github-ci",
 *   roles: ["viewer"],
 *   oidcAuth: {
 *     oidcDiscoveryUrl: "https://token.actions.githubusercontent.com",
 *     boundIssuer: "https://token.actions.githubusercontent.com",
 *     boundAudiences: ["https://github.com/acme"],
 *     boundSubject: "repo:acme/app:ref:refs/heads/main",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ProjectIdentity = Resource<ProjectIdentity>("Infisical.ProjectIdentity");

export const ProjectIdentityProvider = () =>
  Provider.succeed(ProjectIdentity, {
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output) {
        const live = yield* getIdentity(output.project, output.id);
        return live ? { ...output, name: live.name } : undefined;
      }
      // An interrupted create leaves an identity whose attributes were never
      // saved. Its physical name ends with this instance's suffix, whatever
      // prefix it was made with, so it is this resource's own: report it, so
      // the next deploy finishes it or destroy deletes it.
      if (!olds) return undefined;
      const [live] = yield* instanceIdentities(olds.project, id, instanceId);
      return live
        ? {
            id: live.id,
            project: olds.project,
            name: live.name,
            roles: ordered(olds.roles),
            oidcAuth: withDefaults(olds.oidcAuth),
          }
        : undefined;
    }),
    diff: Effect.fn(function* ({ id, instanceId, news, output }) {
      if (!output) return undefined;
      if (!("project" in news) || !isResolved(news.project) || news.project !== output.project) {
        return { action: "replace" } as const;
      }
      if (!isResolved<ProjectIdentityProps>(news)) return { action: "update" } as const;
      const live = yield* getIdentity(output.project, output.id);
      if (!live) return { action: "update" } as const;
      const name = yield* identityName(id, instanceId, news.name);
      const roles = yield* getRoles(output.project, output.id);
      const oidcAuth = yield* getOidcAuth(live);
      return live.name === name &&
        sameRoles(roles, ordered(news.roles)) &&
        oidcAuth !== undefined &&
        sameOidcAuth(oidcAuth, withDefaults(news.oidcAuth))
        ? undefined
        : ({ action: "update" } as const);
    }),
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const project = news.project;
      const name = yield* identityName(id, instanceId, news.name);
      const roles = ordered(news.roles);
      const oidcAuth = withDefaults(news.oidcAuth);
      const observed = output
        ? yield* getIdentity(output.project, output.id)
        : (yield* instanceIdentities(project, id, instanceId))[0];

      return yield* Effect.acquireUseRelease(
        observed
          ? Effect.succeed(observed)
          : infisical
              .createProjectMachineIdentity({
                projectId: project,
                name,
                roles: roles.map((role) => ({ role, isTemporary: false })),
              })
              .pipe(
                Effect.map(({ identity }) => identity),
                // A retried create can leave a second identity with this name.
                infisical.Retry.none,
              ),
        Effect.fn(function* (identity) {
          if (identity.name !== name) {
            yield* infisical.updateProjectMachineIdentity({
              projectId: project,
              identityId: identity.id,
              name,
            });
          }
          if (!sameRoles(yield* getRoles(project, identity.id), roles)) {
            yield* infisical.updateProjectIdentityMembership2({
              projectId: project,
              identityId: identity.id,
              roles: roles.map((role) => ({ role, isTemporary: false })),
            });
          }
          const current = yield* getOidcAuth(identity);
          if (!current) {
            yield* infisical.attachOidcAuth({ identityId: identity.id, ...oidcRequest(oidcAuth) });
          } else if (!sameOidcAuth(current, oidcAuth)) {
            yield* infisical.updateOidcAuth({ identityId: identity.id, ...oidcRequest(oidcAuth) });
          }
          return { id: identity.id, project, name, roles, oidcAuth };
        }),
        (identity, exit) =>
          !observed && Exit.isFailure(exit) ? deleteIdentity(project, identity.id) : Effect.void,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteIdentity(output.project, output.id);
    }),
  });

const identityName = (id: string, instanceId: string, prefix: string) =>
  createPhysicalName({ id, instanceId, prefix: `${prefix}-` });

const ordered = (roles: readonly string[]) => Array.dedupe(roles).toSorted();

const getIdentity = (project: string, identity: string) =>
  infisical.getProjectMachineIdentityById({ projectId: project, identityId: identity }).pipe(
    Effect.map(({ identity }) => identity),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const deleteIdentity = (project: string, identity: string) =>
  infisical.deleteProjectMachineIdentity({ projectId: project, identityId: identity }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

/**
 * The project's identities made by this resource instance: their names end
 * with its 80-bit instance suffix, whatever prefix each was made with.
 */
const instanceIdentities = Effect.fnUntraced(function* (
  project: string,
  id: string,
  instanceId: string,
) {
  const suffix = yield* createPhysicalName({ id, instanceId, prefix: "" });
  const { identities } = yield* infisical.listProjectMachineIdentities({
    projectId: project,
    search: suffix,
    limit: 100,
  });
  return identities.filter(({ name }) => name.endsWith(suffix));
});

const getRoles = (project: string, identity: string) =>
  infisical
    .getProjectIdentityMembership({ projectId: project, identityId: identity })
    .pipe(Effect.map(({ identityMembership }) => identityMembership.roles));

/** The identity holds exactly these roles, none of them temporary. */
const sameRoles = (
  live: infisical.GetProjectIdentityMembershipResponseIdentityMembershipRolesList,
  roles: readonly string[],
) =>
  live.every((role) => !role.isTemporary) &&
  sameSlugs(ordered(live.map((role) => role.customRoleSlug ?? role.role)), roles);

const sameSlugs = Schema.toEquivalence(Schema.Array(Schema.String));

const oidcDefaults = {
  boundAudiences: [],
  boundSubject: "",
  boundClaims: {},
  claimMetadataMapping: {},
  caCert: "",
  accessTokenTTL: 2592000,
  accessTokenMaxTTL: 2592000,
  accessTokenNumUsesLimit: 0,
  accessTokenTrustedIps: ["0.0.0.0/0", "::/0"],
} as const;

const withDefaults = (auth: OidcAuth): Required<OidcAuth> => ({ ...oidcDefaults, ...auth });

const OidcAuthSchema = Schema.Struct({
  oidcDiscoveryUrl: Schema.String,
  boundIssuer: Schema.String,
  boundAudiences: Schema.Array(Schema.String),
  boundSubject: Schema.String,
  boundClaims: Schema.Record(Schema.String, Schema.String),
  claimMetadataMapping: Schema.Record(Schema.String, Schema.String),
  caCert: Schema.String,
  accessTokenTTL: Schema.Number,
  accessTokenMaxTTL: Schema.Number,
  accessTokenNumUsesLimit: Schema.Number,
  accessTokenTrustedIps: Schema.Array(Schema.String),
});

const sameOidcAuth = Schema.toEquivalence(OidcAuthSchema);

const TrustedIps = Schema.Array(
  Schema.Struct({ ipAddress: Schema.String, prefix: Schema.optionalKey(Schema.Number) }),
);

/**
 * The identity's OIDC auth in the shape of {@link OidcAuth}, or undefined when
 * none is attached. `getOidcAuth` has no distinct error for that case, so the
 * identity's `authMethods` decide first.
 */
const getOidcAuth = Effect.fnUntraced(function* (identity: {
  readonly id: string;
  readonly authMethods?: readonly string[];
}) {
  if (identity.authMethods && !identity.authMethods.includes("oidc-auth")) return undefined;
  const auth = yield* infisical.getOidcAuth({ identityId: identity.id }).pipe(
    Effect.map(({ identityOidcAuth }) => identityOidcAuth),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
  if (!auth) return undefined;
  // Infisical returns audiences comma-joined and trusted IPs as address and prefix.
  const ips = yield* Schema.decodeUnknownEffect(TrustedIps)(auth.accessTokenTrustedIps ?? []);
  return yield* Schema.decodeUnknownEffect(OidcAuthSchema)({
    ...oidcDefaults,
    ...auth,
    boundAudiences: auth.boundAudiences === "" ? [] : auth.boundAudiences.split(","),
    boundSubject: auth.boundSubject ?? "",
    boundClaims: auth.boundClaims ?? {},
    claimMetadataMapping: auth.claimMetadataMapping ?? {},
    accessTokenTrustedIps: ips.map(({ ipAddress, prefix }) =>
      prefix === undefined ? ipAddress : `${ipAddress}/${prefix}`,
    ),
  });
});

const oidcRequest = (auth: Required<OidcAuth>) => ({
  ...auth,
  boundAudiences: auth.boundAudiences.join(","),
  accessTokenTrustedIps: auth.accessTokenTrustedIps.map((ipAddress) => ({ ipAddress })),
});
