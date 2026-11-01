import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import { DESCRIPTION_MAX_LENGTH, MissingCredentialInResponse, toRedacted } from "./internal.ts";

export interface AppRoleSecretIdProps {
  /** Instance of the AppRole. Changing it replaces the secret id. */
  instanceId: string;
  /**
   * Role id of the AppRole, e.g. a `Stackit.SecretsManager.AppRole`'s `roleId`.
   * Changing it replaces the secret id.
   */
  roleId: string;
  /**
   * Description telling secret ids apart. If omitted, a unique one is generated
   * from the stack, stage and logical ID, and Alchemy uses it to find a secret id
   * whose create crashed before state was saved, so keep it if you rely on that.
   */
  description?: string;
  /**
   * Change this to rotate the secret id. The new one is created first, then the
   * old one is deleted. Nothing else about a secret id can rotate it, since
   * STACKIT only returns the value when it creates one.
   */
  rotationKey?: string;
  /**
   * Project of the instance. Defaults to the profile's project. Changing it
   * replaces the secret id.
   */
  projectId?: string;
}

export interface AppRoleSecretIdAttributes {
  /**
   * Version of the secret id, its accessor for management calls. Changes when the
   * secret id is recreated.
   */
  version: number;
  /**
   * The secret id, the other half of an AppRole login. STACKIT returns it only
   * when it creates one, so this comes from Alchemy's state. `undefined` only on
   * a secret id recovered from a crashed create; the next deploy recreates it.
   */
  secretId: Redacted.Redacted<string> | undefined;
  /** Role id of the AppRole. */
  roleId: string;
  /** Instance of the AppRole. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** Description of the secret id. */
  description: string;
  /** Logins this secret id allows; `0` means no limit. */
  numUses: number;
  /** Lifetime of this secret id, as STACKIT reports it; `0s` means no time limit. */
  ttl: string;
}

export type AppRoleSecretId = Resource<
  "Stackit.SecretsManager.AppRoleSecretId",
  AppRoleSecretIdProps,
  AppRoleSecretIdAttributes,
  never,
  Providers
>;

/**
 * A secret id of a STACKIT Secrets Manager AppRole: the other half of an AppRole
 * login. Its lifetime and use limit are copied from the AppRole when it's
 * created.
 *
 * STACKIT returns the value only once, so Alchemy keeps it in state as a
 * `Redacted` value. Every plan checks the secret id still exists. When it passed
 * its lifetime or use limit and STACKIT stopped returning it, or it was deleted
 * out of band, the next deploy creates a new one, so `secretId` changes and
 * everything depending on it redeploys.
 *
 * ### Creating a Secret Id
 * **Example:** A secret id for a workload's AppRole
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
 *   description: "Production deployment credential",
 * });
 * ```
 *
 * ### Rotating
 * **Example:** Replace the secret id with no downtime for the role id
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
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Secrets Manager
 * @category SecretsManager
 */
export const AppRoleSecretId = Resource<AppRoleSecretId>("Stackit.SecretsManager.AppRoleSecretId");

const resolveDescription = (id: string, description: string | undefined) =>
  description !== undefined
    ? Effect.succeed(description)
    : createPhysicalName({ id, lowercase: true, maxLength: DESCRIPTION_MAX_LENGTH });

interface SecretIdLocation {
  readonly projectId: string;
  readonly instanceId: string;
  readonly roleId: string;
}

const getSecretIdOrUndefined = (at: SecretIdLocation, secretIdVersion: number) =>
  secretsManager
    .getApproleSecretId({ ...at, secretIdVersion })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findSecretIdByDescription = (at: SecretIdLocation, description: string) =>
  secretsManager
    .listApproleSecretIds(at)
    .pipe(Effect.map(({ secretIds }) => secretIds.find((s) => s.description === description)));

const deleteSecretId = (at: SecretIdLocation, secretIdVersion: number) =>
  secretsManager
    .deleteApproleSecretId({ ...at, secretIdVersion })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const toAttrs = (
  at: SecretIdLocation,
  observed: secretsManager.ApproleSecret,
  secretId: Redacted.Redacted<string> | undefined,
): AppRoleSecretIdAttributes => ({
  version: observed.version,
  secretId,
  roleId: at.roleId,
  instanceId: at.instanceId,
  projectId: at.projectId,
  description: observed.description,
  numUses: observed.num_uses,
  ttl: observed.ttl,
});

export const AppRoleSecretIdProvider = () =>
  Provider.succeed(AppRoleSecretId, {
    // Not `version`: an update recreates a secret id that has expired.
    stables: ["roleId", "instanceId", "projectId"],
    // Secret ids go with their AppRole and instance. There is no `list`: nothing
    // on a secret id tells it apart beyond a description.
    nuke: { dependsOn: ["Stackit.SecretsManager.AppRole", "Stackit.SecretsManager.Instance"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<AppRoleSecretIdProps>(news, [
          "instanceId",
          "roleId",
          "projectId",
          "rotationKey",
        ])
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if (
        news.instanceId !== output.instanceId ||
        news.roleId !== output.roleId ||
        (news.projectId ?? env.projectId) !== output.projectId ||
        news.rotationKey !== olds?.rotationKey
      ) {
        return { action: "replace" } as const;
      }
      // The engine only calls `read` to recover or adopt, so expiry is decided
      // here: this is what every plan runs. Reconcile recreates what's gone.
      const observed = yield* getSecretIdOrUndefined(
        { projectId: output.projectId, instanceId: output.instanceId, roleId: output.roleId },
        output.version,
      );
      return observed === undefined ? ({ action: "update" } as const) : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      const roleId = output?.roleId ?? olds?.roleId;
      if (instanceId === undefined || roleId === undefined) return undefined;
      const at = { projectId, instanceId, roleId };
      if (output !== undefined) {
        const observed = yield* getSecretIdOrUndefined(at, output.version);
        // The value isn't in the response; it stays what state recorded.
        return observed && toAttrs(at, observed, output.secretId);
      }
      // A crashed create: only a generated description can claim the secret id.
      if (olds?.description !== undefined) return undefined;
      const description = yield* resolveDescription(id, undefined);
      const found = yield* findSecretIdByDescription(at, description).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      return found && toAttrs(at, found, undefined);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const at = { projectId, instanceId: news.instanceId, roleId: news.roleId };
      const generated = yield* resolveDescription(id, undefined);
      const description = news.description ?? output?.description ?? generated;

      // 1. Observe: by the version in state, then by this generation's generated
      // description. Any other description can be someone else's secret id.
      const sameRole =
        output?.instanceId === at.instanceId &&
        output.roleId === at.roleId &&
        output.projectId === projectId;
      let observed: secretsManager.ApproleSecret | undefined;
      if (sameRole) observed = yield* getSecretIdOrUndefined(at, output.version);
      if (observed === undefined && description === generated) {
        observed = yield* findSecretIdByDescription(at, description);
      }
      let secretId = sameRole && observed?.version === output.version ? output.secretId : undefined;

      // A secret id with no known value is useless, and only a create returns one.
      if (observed !== undefined && secretId === undefined) {
        yield* deleteSecretId(at, observed.version);
        observed = undefined;
      }

      // 2. Ensure
      if (observed === undefined) {
        const created = yield* secretsManager.createApproleSecretId({ ...at, description });
        if (created.secret_id === undefined) {
          return yield* new MissingCredentialInResponse({
            resource: `AppRole ${at.roleId} secret id`,
            message: "createApproleSecretId answered without a secret_id",
          });
        }
        secretId = toRedacted(created.secret_id);
        observed = created;
      }

      // 3. Sync
      if (observed.description !== description) {
        yield* secretsManager.updateApproleSecretId({
          ...at,
          secretIdVersion: observed.version,
          description,
        });
        observed = { ...observed, description };
      }

      // 4. Return
      return toAttrs(at, observed, secretId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteSecretId(
        { projectId: output.projectId, instanceId: output.instanceId, roleId: output.roleId },
        output.version,
      );
    }),
  });
