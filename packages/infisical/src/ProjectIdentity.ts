import * as InfisicalApi from "@distilled.cloud/infisical";
import type { Credentials } from "@distilled.cloud/infisical/Credentials";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
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

/** Properties for a machine identity confined to one Infisical project. */
export interface ProjectIdentityProps {
  /** Project UUID. Changing it replaces the identity. */
  project: string;
  /** Non-empty name prefix; the physical name includes an instance suffix. Updates in place. */
  name: string;
  /** Non-empty list of permanent project role slugs. Undeclared roles are revoked. Updates in place. */
  roles: readonly [string, ...string[]];
  /** OIDC settings. Omitted fields restore Infisical's defaults. Updates in place. */
  oidcAuth: OidcAuth;
}

/** Output attributes of a project machine identity. No credentials are retained. */
export interface ProjectIdentityAttributes {
  /** Machine identity ID, usable as INFISICAL_IDENTITY_ID in CI. */
  id: string;
  /** Project UUID that confines this identity. */
  project: string;
  /** Physical identity name, including its instance suffix. */
  name: string;
  /** Granted project role slugs, deduplicated and sorted. */
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
 * An Infisical project machine identity with permanent project roles and OIDC
 * authentication. CI can log in with its platform's OIDC token by setting
 * `INFISICAL_IDENTITY_ID` to this resource's `id`. No token is created or
 * retained in Alchemy state. Deleting the identity revokes its issued tokens.
 *
 * The deployment identity needs permission to manage machine identities,
 * identity memberships, and OIDC authentication in the target project.
 *
 * :::caution
 * Changing `project` replaces the identity. Consumers switch to the new
 * identity before the old one is deleted. Name, roles, and OIDC settings
 * update in place; removing an optional OIDC field restores its default.
 * :::
 *
 * Identities have no Alchemy ownership label or tag. The instance suffix in
 * the physical name lets this resource recover an interrupted create, even
 * after a name-prefix change, so the next deploy can finish or destroy can
 * delete it. `list` returns nothing because a name alone cannot prove which
 * stack owns an identity; account-wide cleanup must not offer other identities
 * for deletion.
 *
 * @see https://infisical.com/docs/documentation/platform/identities/oidc-auth
 *
 * ### Creating a CI Identity
 * **Example:** GitHub Actions identity confined to one project
 * ```typescript
 * import * as Infisical from "@alchemy.run/infisical";
 * import * as Effect from "effect/Effect";
 *
 * const ci = Effect.gen(function* () {
 *   return yield* Infisical.ProjectIdentity("CI", {
 *     project: "00000000-0000-4000-8000-000000000000",
 *     name: "github-ci",
 *     roles: ["viewer"],
 *     oidcAuth: {
 *       oidcDiscoveryUrl: "https://token.actions.githubusercontent.com",
 *       boundIssuer: "https://token.actions.githubusercontent.com",
 *       boundAudiences: ["https://github.com/acme"],
 *       boundSubject: "repo:acme/app:ref:refs/heads/main",
 *     },
 *   });
 * });
 * ```
 *
 * @resource
 */
export const ProjectIdentity = Resource<ProjectIdentity>("Infisical.ProjectIdentity");

/** The identity cannot satisfy its declared project, roles, or OIDC settings. */
export class ProjectIdentityError extends Data.TaggedError("ProjectIdentityError")<{
  readonly message: string;
}> {}

const OidcAuthSchema = Schema.Struct({
  oidcDiscoveryUrl: Schema.NonEmptyString,
  boundIssuer: Schema.NonEmptyString,
  boundAudiences: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  boundSubject: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  boundClaims: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  claimMetadataMapping: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  caCert: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  accessTokenTTL: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(2592000))),
  accessTokenMaxTTL: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(2592000))),
  accessTokenNumUsesLimit: Schema.Natural.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  accessTokenTrustedIps: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(["0.0.0.0/0", "::/0"])),
  ),
});

const ProjectIdentityPropsSchema = Schema.Struct({
  project: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  roles: Schema.NonEmptyArray(Schema.NonEmptyString),
  oidcAuth: OidcAuthSchema,
});

const TrustedIps = Schema.Array(
  Schema.Struct({
    ipAddress: Schema.String,
    prefix: Schema.optionalKey(Schema.Natural),
  }),
);

const ordered = (values: readonly string[]) => Array.dedupe(values).toSorted();
const sameRoles = Schema.toEquivalence(Schema.Array(Schema.String));
const sameOidcAuth = Schema.toEquivalence(Schema.toType(OidcAuthSchema));

const roleSlug = (
  role: InfisicalApi.GetProjectIdentityMembershipResponseIdentityMembershipRolesItem,
) => role.customRoleSlug ?? role.role;

const exactRoles = (
  roles: InfisicalApi.GetProjectIdentityMembershipResponseIdentityMembershipRolesList,
  desired: readonly string[],
) =>
  roles.every((role) => !role.isTemporary) &&
  sameRoles(ordered(roles.map(roleSlug)), ordered(desired));

const oidcRequest = (auth: typeof OidcAuthSchema.Type) => ({
  ...auth,
  boundAudiences: auth.boundAudiences.join(","),
  accessTokenTrustedIps: auth.accessTokenTrustedIps.map((ipAddress) => ({ ipAddress })),
});

export const ProjectIdentityProvider = () =>
  Provider.effect(
    ProjectIdentity,
    Effect.gen(function* () {
      const api = Effect.provideContext(
        yield* Effect.context<Credentials | HttpClient.HttpClient>(),
      );
      const error = (project: string, identity: string, action: string) =>
        new ProjectIdentityError({
          message: `Infisical project ${project} identity ${identity}: ${action}`,
        });
      const operation = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
        effect.pipe(InfisicalApi.Retry.none, api);

      const get = (project: string, identity: string) =>
        InfisicalApi.getProjectMachineIdentityById({
          projectId: project,
          identityId: identity,
        }).pipe(
          Effect.map(({ identity }) => identity),
          Effect.catchTag("NotFound", () => Effect.undefined),
          operation,
        );

      const remove = (project: string, identity: string) =>
        InfisicalApi.deleteProjectMachineIdentity({
          projectId: project,
          identityId: identity,
        }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.asVoid,
          operation,
        );

      const inspect = Effect.fnUntraced(function* (project: string, id: string) {
        const identity = yield* get(project, id);
        if (!identity) return undefined;
        if (identity.projectId !== project) {
          return yield* error(project, id, "is not an identity confined to this project");
        }
        const { membership, auth } = yield* Effect.all(
          {
            membership: InfisicalApi.getProjectIdentityMembership({
              projectId: project,
              identityId: id,
            }).pipe(
              Effect.map(({ identityMembership }) => identityMembership),
              operation,
            ),
            auth:
              identity.authMethods && !identity.authMethods.includes("oidc-auth")
                ? Effect.undefined
                : InfisicalApi.getOidcAuth({ identityId: id }).pipe(
                    Effect.map(({ identityOidcAuth }) => identityOidcAuth),
                    Effect.catchTag("NotFound", () => Effect.undefined),
                    operation,
                  ),
          },
          { concurrency: 2 },
        );
        const oidcAuth = auth
          ? yield* Effect.gen(function* () {
              const ips =
                auth.accessTokenTrustedIps === undefined
                  ? undefined
                  : yield* Schema.decodeUnknownEffect(TrustedIps)(auth.accessTokenTrustedIps);
              return yield* Schema.decodeUnknownEffect(OidcAuthSchema)({
                ...auth,
                boundAudiences: auth.boundAudiences === "" ? [] : auth.boundAudiences.split(","),
                boundSubject: auth.boundSubject ?? "",
                boundClaims: auth.boundClaims ?? {},
                claimMetadataMapping: auth.claimMetadataMapping ?? {},
                accessTokenTrustedIps: ips?.map(({ ipAddress, prefix }) =>
                  prefix === undefined ? ipAddress : `${ipAddress}/${prefix}`,
                ),
              });
            }).pipe(Effect.mapError(() => error(project, id, "returned invalid OIDC auth")))
          : undefined;
        return { identity, membership, auth, oidcAuth };
      });

      const converge = Effect.fnUntraced(function* (
        project: string,
        id: string,
        name: string,
        props: typeof ProjectIdentityPropsSchema.Type,
        current?: NonNullable<Effect.Success<ReturnType<typeof inspect>>>,
      ) {
        const live = current ?? (yield* inspect(project, id));
        if (!live) return yield* error(project, id, "disappeared during reconciliation");
        if (live.identity.name !== name) {
          yield* InfisicalApi.updateProjectMachineIdentity({
            projectId: project,
            identityId: id,
            name,
          }).pipe(operation);
        }
        if (!exactRoles(live.membership.roles, props.roles)) {
          yield* InfisicalApi.updateProjectIdentityMembership2({
            projectId: project,
            identityId: id,
            roles: ordered(props.roles).map((role) => ({ role, isTemporary: false })),
          }).pipe(operation);
        }
        if (!live.auth) {
          yield* InfisicalApi.attachOidcAuth({
            identityId: id,
            ...oidcRequest(props.oidcAuth),
          }).pipe(operation);
        } else if (
          !live.oidcAuth ||
          !sameOidcAuth(live.oidcAuth, props.oidcAuth) ||
          live.auth.templateId
        ) {
          yield* InfisicalApi.updateOidcAuth({
            identityId: id,
            templateId: null,
            ...oidcRequest(props.oidcAuth),
          }).pipe(operation);
        }
        const updated = yield* inspect(project, id);
        if (
          !updated ||
          updated.identity.name !== name ||
          !exactRoles(updated.membership.roles, props.roles) ||
          !updated.oidcAuth ||
          !sameOidcAuth(updated.oidcAuth, props.oidcAuth) ||
          updated.auth?.templateId
        ) {
          return yield* error(
            project,
            id,
            "did not converge to its declared name, permanent roles and OIDC auth",
          );
        }
        return {
          id,
          project,
          name: updated.identity.name,
          roles: ordered(updated.membership.roles.map(roleSlug)),
          oidcAuth: updated.oidcAuth,
        };
      });

      const find = Effect.fnUntraced(function* (project: string, id: string, instanceId: string) {
        const suffix = yield* createPhysicalName({ id, instanceId, prefix: "" });
        const matches: InfisicalApi.ListProjectMachineIdentitiesResponseIdentitiesItem[] = [];
        let offset = 0;
        while (true) {
          const page = yield* InfisicalApi.listProjectMachineIdentities({
            projectId: project,
            search: suffix,
            offset,
            limit: 100,
          }).pipe(operation);
          matches.push(...page.identities.filter((identity) => identity.name.endsWith(suffix)));
          offset += page.identities.length;
          if (offset >= page.totalCount) break;
          if (page.identities.length === 0) {
            return yield* error(
              project,
              id,
              "identity search stopped before returning every match",
            );
          }
        }
        if (matches.length > 1) {
          return yield* error(
            project,
            id,
            `instance suffix ${suffix} is ambiguous: ${matches.map(({ id, name }) => `${name} (${id})`).join(", ")}`,
          );
        }
        return matches[0];
      });

      return {
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          let reference = output && {
            id: output.id,
            project: output.project,
            oidcAuth: output.oidcAuth,
          };
          if (!reference && olds) {
            const props = yield* Schema.decodeEffect(ProjectIdentityPropsSchema)(olds).pipe(
              Effect.mapError(() => error(olds.project, id, "invalid saved declaration")),
            );
            const existing = yield* find(props.project, id, instanceId);
            if (existing) {
              reference = { id: existing.id, project: props.project, oidcAuth: props.oidcAuth };
            }
          }
          if (!reference) return undefined;
          const live = yield* inspect(reference.project, reference.id);
          if (!live) return undefined;
          return {
            id: live.identity.id,
            project: reference.project,
            name: live.identity.name,
            roles: ordered(live.membership.roles.map(roleSlug)),
            // Keep tracking the identity if OIDC was removed; diff detects
            // the missing method and reconcile attaches the declaration.
            oidcAuth: live.oidcAuth ?? reference.oidcAuth,
          };
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, output }) {
          if (!output) return undefined;
          if (
            !("project" in news) ||
            !isResolved(news.project) ||
            news.project !== output.project
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved<ProjectIdentityProps>(news)) return { action: "update" } as const;
          const props = yield* Schema.decodeEffect(ProjectIdentityPropsSchema)(news).pipe(
            Effect.mapError(() => error(output.project, output.id, "invalid declaration")),
          );
          const name = yield* createPhysicalName({ id, instanceId, prefix: `${props.name}-` });
          const live = yield* inspect(output.project, output.id);
          return !live ||
            live.identity.name !== name ||
            !exactRoles(live.membership.roles, props.roles) ||
            !live.oidcAuth ||
            !sameOidcAuth(live.oidcAuth, props.oidcAuth) ||
            live.auth?.templateId
            ? ({ action: "update" } as const)
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const props = yield* Schema.decodeEffect(ProjectIdentityPropsSchema)(news).pipe(
            Effect.mapError(() => error(news.project, id, "invalid declaration")),
          );
          const project = props.project;
          const name = yield* createPhysicalName({ id, instanceId, prefix: `${props.name}-` });
          let observed = output ? yield* inspect(output.project, output.id) : undefined;
          if (observed && output?.project !== project) {
            return yield* error(
              project,
              observed.identity.id,
              "project changes require replacement",
            );
          }
          if (!observed) {
            const existing = yield* find(project, id, instanceId);
            if (existing) observed = yield* inspect(project, existing.id);
          }
          return yield* Effect.acquireUseRelease(
            observed
              ? Effect.succeed(observed.identity)
              : InfisicalApi.createProjectMachineIdentity({
                  projectId: project,
                  name,
                  roles: ordered(props.roles).map((role) => ({ role, isTemporary: false })),
                }).pipe(
                  Effect.map(({ identity }) => identity),
                  operation,
                ),
            (identity) => converge(project, identity.id, name, props, observed),
            (identity, exit) =>
              !observed && Exit.isFailure(exit) ? remove(project, identity.id) : Effect.void,
          );
        }),
        delete: ({ output }) => remove(output.project, output.id),
      };
    }),
  );
