import { createHash } from "node:crypto";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import { appRoleVaultCredentials, VaultCredentials } from "@distilled.cloud/stackit/Vault";
import { ResourceContext } from "alchemy/ResourceContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/** How long an instance has to report that its creation finished. */
export const INSTANCE_READY_TIMEOUT = "2 minutes";

/** Generated instance names; STACKIT documents no limit, so this is conservative. */
export const INSTANCE_NAME_MAX_LENGTH = 63;

/** Generated user, AppRole and secret id descriptions. */
export const DESCRIPTION_MAX_LENGTH = 63;

/**
 * An API call STACKIT answered without the credential it only returns from that
 * one call, so the credential is lost to Alchemy.
 */
export class MissingCredentialInResponse extends Data.TaggedError(
  "Stackit.SecretsManager.MissingCredentialInResponse",
)<{
  readonly resource: string;
  readonly message: string;
}> {}

export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/** A bounded retry of an update refused with `Conflict` while another one is in flight. */
export const retryConflict = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      schedule: Schedule.exponential("1 second"),
      times: 6,
    }),
  );

/** `GetInstance`; `undefined` once the instance is gone (typed `NotFound`). */
export const getInstanceOrUndefined = (projectId: string, instanceId: string) =>
  secretsManager
    .getInstance({ projectId, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every AppRole of an instance. The API doesn't page this list. */
export const listInstanceAppRoles = (projectId: string, instanceId: string) =>
  secretsManager.listApproles({ projectId, instanceId }).pipe(Effect.map((list) => list.approles));

/**
 * A Secrets Manager duration in seconds. The API takes `15m` but answers
 * `15m0s` (and `24h` as `24h0m0s`, per STACKIT's AppRole docs), so durations are
 * compared by value. `undefined` when the text isn't a duration.
 */
export const durationSeconds = (duration: string): number | undefined => {
  if (!/^(\d+[hms])+$/.test(duration)) return undefined;
  const units: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const [, amount, unit] of duration.matchAll(/(\d+)([hms])/g)) {
    seconds += Number(amount) * units[unit!]!;
  }
  return seconds;
};

/** Whether two durations are the same length; unparseable ones compare as text. */
export const sameDuration = (a: string, b: string): boolean => {
  const left = durationSeconds(a);
  return left !== undefined && left === durationSeconds(b) ? true : a === b;
};

/**
 * Description of the short-lived AppRole a deploy uses for one `Secret`. Runs of
 * other stacks, stages or namespaces can share the vault, and each run deletes
 * every role with this description as stale, so it names the stack, the stage and
 * the fully-qualified name. Generations share it: a role a crash left behind is
 * this resource's leftover, whichever generation left it. The hash keeps a long
 * name distinct when the description is cut to the API's limit.
 */
const deployAppRoleDescription = (write: boolean) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const stage = yield* Stage;
    const { fqn } = yield* ResourceContext;
    const identity = `${stack.name}/${stage}/${fqn}`;
    const hash = yield* Effect.sync(() =>
      createHash("sha256").update(identity).digest("hex").slice(0, 16),
    );
    return `alchemy-deploy-${write ? "rw" : "ro"}-${hash}-${identity}`.slice(0, 255);
  });

/** How long a deploy's secret id works, if its AppRole outlives a crashed deploy. */
const DEPLOY_SECRET_ID_TTL = "15m";

const deleteAppRole = (projectId: string, instanceId: string, roleId: string) =>
  secretsManager
    .deleteApprole({ projectId, instanceId, roleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

/**
 * Run Vault operations at deploy time. Vault doesn't take the deployer's STACKIT
 * token, so this mints a short-lived AppRole and secret id with the management
 * API, provides `VaultCredentials` from them, and always deletes the AppRole
 * afterwards. A deploy that crashes in between leaves an AppRole whose secret id
 * expires in 15 minutes, and the next run for that resource deletes it first.
 *
 * Deleting an AppRole invalidates its secret ids. A token already issued keeps
 * working until it expires, 15 minutes at most: STACKIT documents no way to
 * revoke it through the management API.
 */
export const withDeployVault = <A, E, R>(
  options: {
    readonly projectId: string;
    readonly instanceId: string;
    /** The instance's `apiUrl`. */
    readonly apiUrl: string;
    /** Whether the operations write. A read-only run mints a read-only AppRole. */
    readonly write: boolean;
  },
  use: Effect.Effect<A, E, R>,
) => {
  const { projectId, instanceId, apiUrl, write } = options;
  return deployAppRoleDescription(write).pipe(
    Effect.flatMap((description) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const stale = yield* listInstanceAppRoles(projectId, instanceId);
          for (const role of stale.filter((role) => role.description === description)) {
            yield* deleteAppRole(projectId, instanceId, role.role_id);
          }
          return yield* secretsManager.createApprole({
            projectId,
            instanceId,
            description,
            write,
            secret_id_ttl: DEPLOY_SECRET_ID_TTL,
          });
        }),
        (role) =>
          Effect.gen(function* () {
            const { secret_id: secretId } = yield* secretsManager.createApproleSecretId({
              projectId,
              instanceId,
              roleId: role.role_id,
              description,
            });
            if (secretId === undefined) {
              return yield* new MissingCredentialInResponse({
                resource: `AppRole ${role.role_id}`,
                message: "createApproleSecretId answered without a secret_id",
              });
            }
            const client = yield* HttpClient.HttpClient;
            const credentials = appRoleVaultCredentials({
              apiUrl,
              roleId: role.role_id,
              secretId: toRedacted(secretId),
            }).pipe(Effect.provideService(HttpClient.HttpClient, client));
            return yield* use.pipe(Effect.provideService(VaultCredentials, credentials));
          }),
        // The deploy's result doesn't depend on this cleanup, and the next run
        // retries it for a role left behind.
        (role) => deleteAppRole(projectId, instanceId, role.role_id).pipe(Effect.ignore),
      ),
    ),
  );
};
