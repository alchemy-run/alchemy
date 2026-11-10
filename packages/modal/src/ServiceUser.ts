import * as environment from "@distilled.cloud/modal/environment";
import * as service from "@distilled.cloud/modal/service";
import * as workspace from "@distilled.cloud/modal/workspace";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type EnvironmentInput, envNameOf, objectName, seconds } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import type { DurationInput } from "./SandboxClient.ts";

export class ServiceUserUnexpectedResponse extends Data.TaggedError(
  "Modal.ServiceUserUnexpectedResponse",
)<{
  readonly message: string;
}> {}

/**
 * The workspace's plan has no service users (Modal's Starter plan). Bindings
 * create one per host; `Modal.DeployerHostIdentity` binds the deployer's token
 * instead.
 */
export class ServiceUsersNotAvailable extends Data.TaggedError("Modal.ServiceUsersNotAvailable")<{
  readonly message: string;
}> {}

/** A role a scoped service user holds in one environment. */
export interface ServiceUserEnvironmentRole {
  /** The environment: its name, or a yielded `Modal.Environment`. */
  readonly environment: EnvironmentInput;
  /** `viewer` reads; `contributor` also deploys and writes. */
  readonly role: "viewer" | "contributor";
}

export interface ServiceUserProps {
  /**
   * Service user name, unique in the workspace. If omitted, one is generated
   * from the stack, stage and logical ID. Changing it replaces the user (and
   * its token).
   */
  name?: string;
  /**
   * Limit the user to the environments in {@link environments}. An unscoped
   * user acts on the whole workspace. Changing it replaces the user.
   * @default true
   */
  scoped?: boolean;
  /** Roles of a scoped user, per environment. */
  environments?: ServiceUserEnvironmentRole[];
  /**
   * Expire the user's token after this long. Changing it replaces the user.
   * @default never
   */
  expiresIn?: DurationInput;
}

export interface ServiceUserAttributes {
  /** Service user ID. */
  serviceUserId: string;
  /** Service user name. */
  name: string;
  /** Token ID (`ak-…`), the `MODAL_TOKEN_ID` of the user. */
  tokenId: string;
  /** Token secret (`as-…`), the `MODAL_TOKEN_SECRET` of the user. */
  tokenSecret: Redacted.Redacted<string>;
  /** Whether the user is limited to its environments. */
  scoped: boolean;
  /** Roles by environment name. */
  environments: Record<string, "viewer" | "contributor">;
}

/**
 * A Modal service user: a workspace identity with its own token pair, for
 * CI or another system. A scoped user acts only in the environments you
 * grant it, as a `viewer` or a `contributor`.
 *
 * Modal shows a service user's token secret once, at creation, so a user
 * deleted outside Alchemy is recreated with a new token on the next deploy,
 * and an existing user can't be adopted.
 *
 * ### Creating a service user
 * **Example:** CI that deploys to one environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Staging = Modal.Environment("Staging", {});
 * export const Deployer = Modal.ServiceUser("Deployer", {
 *   environments: [{ environment: Staging, role: "contributor" }],
 * });
 * ```
 *
 * **Example:** A short-lived, read-only token
 * ```typescript
 * export const Auditor = Modal.ServiceUser("Auditor", {
 *   environments: [{ environment: "main", role: "viewer" }],
 *   expiresIn: "7 days",
 * });
 * ```
 *
 * ### Using its token
 * **Example:** Hand the pair to a Worker that calls Modal as the user
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * export const Ci = Effect.gen(function* () {
 *   const deployer = yield* Deployer;
 *   return yield* Cloudflare.Worker("Ci", {
 *     main: "./src/ci.ts",
 *     env: { MODAL_TOKEN_ID: deployer.tokenId, MODAL_TOKEN_SECRET: deployer.tokenSecret },
 *   });
 * });
 * ```
 *
 * @resource
 * @product Workspace
 */
export const ServiceUser = declarable<ServiceUser>()(Resource<ServiceUser>("Modal.ServiceUser"));

export type ServiceUser = Resource<
  "Modal.ServiceUser",
  ServiceUserProps,
  ServiceUserAttributes,
  {
    /**
     * Roles contributed by bindings: a binding on a host grants the host's
     * service user the role it needs on the bound resource's environment
     * (`undefined` is the workspace default). The strongest role per
     * environment wins.
     */
    environments?: Array<{
      readonly environment: string | undefined;
      readonly role: "viewer" | "contributor";
    }>;
  },
  Providers
>;

const ROLE = {
  viewer: "ENVIRONMENT_ROLE_VIEWER",
  contributor: "ENVIRONMENT_ROLE_CONTRIBUTOR",
} as const;

const roleOf = (role: string | undefined) =>
  role === ROLE.viewer ? "viewer" : role === ROLE.contributor ? "contributor" : undefined;

/**
 * The roles the props and the bindings ask for, by environment name; the
 * workspace default environment resolves to its name. A `contributor` grant
 * beats a `viewer` grant for the same environment.
 */
const desiredRoles = Effect.fn(function* (
  props: ServiceUserProps,
  bindings: ReadonlyArray<ResourceBinding<ServiceUser["Binding"]>>,
) {
  const entries = [
    ...(props.environments ?? []).map((entry) => ({
      environment: envNameOf(entry.environment),
      role: entry.role,
    })),
    ...bindings
      .filter((binding) => (binding as { action?: string }).action !== "delete")
      .flatMap((binding) => binding.data?.environments ?? []),
  ];
  let defaultName: string | undefined;
  const roles: Record<string, "viewer" | "contributor"> = {};
  for (const entry of entries) {
    let name = entry.environment;
    if (!name) {
      defaultName ??= (yield* workspace.workspaceSettings({})).defaultEnvironmentName ?? "main";
      name = defaultName;
    }
    if (roles[name] !== "contributor") roles[name] = entry.role;
  }
  return roles;
});

export const ServiceUserProvider = () =>
  Provider.effect(
    ServiceUser,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (name: string) {
        const found = yield* service
          .serviceUserInfo({ serviceUserName: name })
          .pipe(Effect.catchTag("ServiceUserNotFound", () => Effect.undefined));
        return found?.serviceUser?.serviceUserId ? found.serviceUser : undefined;
      });

      return {
        stables: ["serviceUserId", "name", "tokenId", "tokenSecret"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if ((yield* objectName(id, news.name)) !== output.name)
            return { action: "replace" } as const;
          if ((news.scoped ?? true) !== output.scoped) return { action: "replace" } as const;
          if (seconds(news.expiresIn) !== seconds(olds?.expiresIn))
            return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* observe(output.name);
          return found?.serviceUserId === output.serviceUserId ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          const scoped = news.scoped ?? true;
          // Observe: the user we created still exists (its secret lives only in state).
          let current: Partial<service.ServiceUser> | undefined = yield* observe(name);
          let token =
            current !== undefined &&
            output !== undefined &&
            current.serviceUserId === output.serviceUserId
              ? { tokenId: output.tokenId, tokenSecret: output.tokenSecret }
              : undefined;
          // Ensure: a user we can't read the secret of is replaced by a fresh one.
          if (token === undefined) {
            if (current?.serviceUserId) {
              yield* service
                .deleteServiceUser({ serviceUserId: current.serviceUserId })
                .pipe(Effect.catchTag("ServiceUserNotFound", () => Effect.void));
            }
            yield* session.note(`Creating service user ${name}...`);
            const created = yield* service
              .createServiceUser({
                name,
                scoped,
                expiresInSeconds: seconds(news.expiresIn),
              })
              .pipe(
                Effect.catchTag("ServiceUsersNotAvailable", (e) =>
                  Effect.fail(
                    new ServiceUsersNotAvailable({
                      message: `${e.message ?? "Service users are not available on this plan."} Modal bindings give each host its own service user; on this plan, add Modal.DeployerHostIdentity to the Stack's providers to bind your own token into hosts instead.`,
                    }),
                  ),
                ),
              );
            if (!created.serviceUserId || !created.tokenId || !created.tokenSecret) {
              return yield* new ServiceUserUnexpectedResponse({
                message: `Modal returned no token for service user ${name}`,
              });
            }
            token = {
              tokenId: created.tokenId,
              tokenSecret: Redacted.isRedacted(created.tokenSecret)
                ? created.tokenSecret
                : Redacted.make(created.tokenSecret),
            };
            current = (yield* observe(name)) ?? { serviceUserId: created.serviceUserId, name };
          }
          const user: Partial<service.ServiceUser> = current ?? {};
          const serviceUserId = user.serviceUserId ?? "";
          // Sync roles against the observed ones; a dropped environment loses access.
          const observed: Record<string, string | undefined> = {};
          for (const entry of user.environmentRoles ?? []) {
            if (entry.environmentName) observed[entry.environmentName] = roleOf(entry.role);
          }
          const desired = scoped ? yield* desiredRoles(news, bindings) : {};
          for (const [env, role] of Object.entries(desired)) {
            if (observed[env] === role) continue;
            yield* environment.setEnvironmentRole({
              environmentName: env,
              serviceUserId,
              role: ROLE[role],
            });
          }
          for (const env of Object.keys(observed)) {
            if (env in desired || observed[env] === undefined) continue;
            yield* environment.setEnvironmentRole({
              environmentName: env,
              serviceUserId,
              role: "ENVIRONMENT_ROLE_NO_ACCESS",
            });
          }
          return {
            serviceUserId,
            name,
            tokenId: token.tokenId,
            tokenSecret: token.tokenSecret,
            scoped,
            environments: desired,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* service
            .deleteServiceUser({ serviceUserId: output.serviceUserId })
            .pipe(Effect.catchTag("ServiceUserNotFound", () => Effect.void));
        }),
      };
    }),
  );
