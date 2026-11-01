import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import { DESCRIPTION_MAX_LENGTH, listInstanceAppRoles, sameDuration } from "./internal.ts";

export interface AppRoleProps {
  /**
   * Instance the AppRole logs in to, e.g. a `Stackit.SecretsManager.Instance`'s
   * `instanceId`. Changing it replaces the AppRole.
   */
  instanceId: string;
  /**
   * Description telling AppRoles apart. If omitted, a unique one is generated
   * from the stack, stage and logical ID, and Alchemy uses it to find an AppRole
   * whose create crashed before state was saved, so keep it if you rely on that.
   */
  description?: string;
  /**
   * Whether the AppRole can write secrets as well as read them. AppRoles can't
   * be limited to a path: an AppRole reads every secret in the instance.
   * @default false
   */
  write?: boolean;
  /**
   * Lifetime of each new secret id, a whole number followed by `s`, `m` or `h`,
   * such as `15m` or `24h`. `0s` means no time limit. Changing it only affects
   * secret ids created afterwards.
   * @default "0s"
   */
  secretIdTtl?: string;
  /**
   * How many logins each new secret id allows. `0` means no limit. Changing it
   * only affects secret ids created afterwards.
   * @default 0
   */
  secretIdNumUses?: number;
  /**
   * Project of the instance. Defaults to the profile's project. Changing it
   * replaces the AppRole.
   */
  projectId?: string;
}

export interface AppRoleAttributes {
  /** Role id, half of an AppRole login. Stable until the AppRole is deleted. */
  roleId: string;
  /** Instance the AppRole logs in to. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** Description of the AppRole. */
  description: string;
  /** Whether the AppRole can write secrets. */
  write: boolean;
  /** Lifetime of each new secret id, as STACKIT reports it (`24h0m0s`). */
  secretIdTtl: string;
  /** Logins each new secret id allows. */
  secretIdNumUses: number;
}

export type AppRole = Resource<
  "Stackit.SecretsManager.AppRole",
  AppRoleProps,
  AppRoleAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Secrets Manager AppRole: a login for workloads, made of a stable
 * role id and one or more secret ids. STACKIT offers AppRole authentication as
 * a public preview.
 *
 * Create the secret half with `Stackit.SecretsManager.AppRoleSecretId`. You
 * rarely need either one yourself: secret bindings such as
 * `Stackit.SecretsManager.ReadSecret` create an AppRole and a secret id per host.
 *
 * Changing `instanceId` or `projectId` replaces the AppRole, which invalidates
 * its secret ids. Everything else updates in place, and `secretIdTtl` and
 * `secretIdNumUses` only affect secret ids created afterwards. An AppRole has no
 * labels, so Alchemy knows it by the role id in state or by a generated
 * description, which is why a generated `description` holds the physical name.
 *
 * ### Creating an AppRole
 * **Example:** Read-only AppRole for a workload
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const role = yield* Stackit.SecretsManager.AppRole("Workload", {
 *   instanceId: vault.instanceId,
 *   description: "Read-only deployment workload",
 * });
 * ```
 *
 * **Example:** Short-lived, single-use secret ids
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const role = yield* Stackit.SecretsManager.AppRole("Job", {
 *   instanceId: vault.instanceId,
 *   write: true,
 *   secretIdTtl: "15m",
 *   secretIdNumUses: 1,
 * });
 * ```
 *
 * ### Logging In
 * **Example:** An AppRole and its secret id
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * const role = yield* Stackit.SecretsManager.AppRole("Workload", {
 *   instanceId: vault.instanceId,
 * });
 * const secretId = yield* Stackit.SecretsManager.AppRoleSecretId("WorkloadSecretId", {
 *   instanceId: vault.instanceId,
 *   roleId: role.roleId,
 * });
 * // Log in with role.roleId and secretId.secretId (Redacted).
 * ```
 *
 * @resource
 * @product STACKIT Secrets Manager
 * @category SecretsManager
 */
export const AppRole = Resource<AppRole>("Stackit.SecretsManager.AppRole");

const resolveDescription = (id: string, description: string | undefined) =>
  description !== undefined
    ? Effect.succeed(description)
    : createPhysicalName({ id, lowercase: true, maxLength: DESCRIPTION_MAX_LENGTH });

const getAppRoleOrUndefined = (projectId: string, instanceId: string, roleId: string) =>
  secretsManager
    .getApprole({ projectId, instanceId, roleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findAppRoleByDescription = (projectId: string, instanceId: string, description: string) =>
  listInstanceAppRoles(projectId, instanceId).pipe(
    Effect.map((roles) => roles.find((role) => role.description === description)),
  );

const toAttrs = (
  projectId: string,
  instanceId: string,
  role: secretsManager.Approle,
): AppRoleAttributes => ({
  roleId: role.role_id,
  instanceId,
  projectId,
  description: role.description,
  write: role.write,
  secretIdTtl: role.secret_id_ttl,
  secretIdNumUses: role.secret_id_num_uses,
});

export const AppRoleProvider = () =>
  Provider.succeed(AppRole, {
    stables: ["roleId", "instanceId", "projectId"],
    // AppRoles go with their instance. There is no `list`: nothing on an AppRole
    // tells it apart beyond a description.
    nuke: { dependsOn: ["Stackit.SecretsManager.Instance"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<AppRoleProps>(news, ["instanceId", "projectId"])) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<AppRoleProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      if (output !== undefined) {
        const role = yield* getAppRoleOrUndefined(projectId, instanceId, output.roleId);
        return role && toAttrs(projectId, instanceId, role);
      }
      // A crashed create: only a generated description can claim the AppRole.
      if (olds?.description !== undefined) return undefined;
      const description = yield* resolveDescription(id, undefined);
      const found = yield* findAppRoleByDescription(projectId, instanceId, description).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      return found && toAttrs(projectId, instanceId, found);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const { instanceId } = news;
      const generated = yield* resolveDescription(id, undefined);
      const description = news.description ?? output?.description ?? generated;
      const write = news.write ?? false;
      const secretIdTtl = news.secretIdTtl ?? "0s";
      const secretIdNumUses = news.secretIdNumUses ?? 0;

      // 1. Observe: by the id in state, then by this generation's generated
      // description. Any other description can be someone else's AppRole.
      let role: secretsManager.Approle | undefined;
      if (output?.instanceId === instanceId && output.projectId === projectId) {
        role = yield* getAppRoleOrUndefined(projectId, instanceId, output.roleId);
      }
      if (role === undefined && description === generated) {
        role = yield* findAppRoleByDescription(projectId, instanceId, description);
      }

      // 2. Ensure
      if (role === undefined) {
        role = yield* secretsManager.createApprole({
          projectId,
          instanceId,
          description,
          write,
          secret_id_ttl: secretIdTtl,
          secret_id_num_uses: secretIdNumUses,
        });
      }

      // 3. Sync: durations by value, since `15m` comes back as `15m0s`.
      if (
        role.description !== description ||
        role.write !== write ||
        !sameDuration(role.secret_id_ttl, secretIdTtl) ||
        role.secret_id_num_uses !== secretIdNumUses
      ) {
        yield* secretsManager.updateApprole({
          projectId,
          instanceId,
          roleId: role.role_id,
          description,
          write,
          secret_id_ttl: secretIdTtl,
          secret_id_num_uses: secretIdNumUses,
        });
        role = yield* secretsManager.getApprole({
          projectId,
          instanceId,
          roleId: role.role_id,
        });
      }

      // 4. Return
      return toAttrs(projectId, instanceId, role);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* secretsManager
        .deleteApprole({
          projectId: output.projectId,
          instanceId: output.instanceId,
          roleId: output.roleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
