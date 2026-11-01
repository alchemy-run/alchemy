import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  getInstanceOrUndefined,
  INSTANCE_NAME_MAX_LENGTH,
  INSTANCE_READY_TIMEOUT,
  retryConflict,
} from "./internal.ts";

/** The STACKIT KMS key an instance encrypts its secrets with. */
export type InstanceKmsKey = {
  /** UUID of the key. */
  keyId: string;
  /** UUID of the key ring holding the key. */
  keyRingId: string;
  /** Version of the key to use. */
  keyVersion: number;
  /**
   * Email of the service account that uses the key. It must be in the same
   * project as the instance.
   */
  serviceAccountEmail: string;
};

export interface InstanceProps {
  /**
   * Name of the instance. STACKIT only uses it to tell instances apart, and it
   * updates in place. If omitted, a unique name is generated from the stack,
   * stage and logical ID.
   */
  name?: string;
  /**
   * CIDR ranges allowed to reach the instance's Vault API, kept as a set. An
   * empty list removes every entry. When omitted, the live list is left alone.
   *
   * Everything that reads or writes secrets has to be inside these ranges, or
   * Vault answers `403 permission denied`: the machine running `alchemy deploy`
   * when the stack has a `Stackit.SecretsManager.Secret`, and each host with a
   * secret binding. Hosts with no stable egress address, such as a Cloudflare
   * Worker, only fit a range as wide as `0.0.0.0/0`.
   */
  acls?: string[];
  /**
   * STACKIT KMS key to encrypt secrets with. Updates in place. When omitted,
   * the live setting is left alone.
   */
  kmsKey?: InstanceKmsKey;
  /**
   * Project that owns the instance. Defaults to the profile's project. Changing
   * it replaces the instance, and an instance's secrets don't move with it.
   */
  projectId?: string;
}

export interface InstanceAttributes {
  /** Instance id (UUID). Stable across updates. Vault mounts the KV engine at this id. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Name of the instance. */
  name: string;
  /** The ACL entries, as CIDR ranges. */
  acls: string[];
  /** The KMS key encrypting the instance's secrets, if any. */
  kmsKey: InstanceKmsKey | undefined;
  /** URL of the instance's Vault API. */
  apiUrl: string;
  /** Name of the instance's secrets engine. */
  secretsEngine: string;
  /** Number of secrets in the instance. STACKIT updates it once an hour. */
  secretCount: number;
  /** State STACKIT reports for the instance. */
  state: string;
  /** When creation started. */
  creationStartDate: string;
  /** When creation finished. */
  creationFinishedDate: string | undefined;
  /** When the last update started. */
  updateStartDate: string | undefined;
  /** When the last update finished. */
  updateFinishedDate: string | undefined;
}

export type Instance = Resource<
  "Stackit.SecretsManager.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Secrets Manager instance: a Vault-compatible KV v2 secrets engine
 * with its own API URL, users and AppRoles.
 *
 * Secret access is instance-wide: a read-only login reads every secret in the
 * instance, and neither users nor AppRoles can be limited to a path. Use one
 * instance per trust boundary.
 *
 * STACKIT only offers the service in `eu01`. Instances have no labels, so a
 * generated name and the id in state are how Alchemy knows one is its own. An
 * instance with an explicit name and no state is reported as unowned and only
 * taken over with `--adopt`. `alchemy unsafe nuke` enumerates instances whose
 * name has the generated shape.
 *
 * ### Creating an Instance
 * **Example:** Basic instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {});
 * ```
 *
 * **Example:** Instance with an explicit name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   name: "payments-prod",
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Allow only an office network and a CI runner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["198.51.100.0/24", "203.0.113.7/32"],
 * });
 * ```
 *
 * ### Encrypting with Your Own Key
 * **Example:** Encrypt secrets with a STACKIT KMS key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   kmsKey: {
 *     keyId: "00000000-0000-0000-0000-000000000001",
 *     keyRingId: "00000000-0000-0000-0000-000000000002",
 *     keyVersion: 1,
 *     serviceAccountEmail: "kms-user@sa.stackit.cloud",
 *   },
 * });
 * ```
 *
 * ### Storing and Reading Secrets
 * **Example:** A secret written at deploy, read by a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["0.0.0.0/0"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const secrets = yield* Stackit.SecretsManager.ReadSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* secrets.get({ secretPath: "payments/api" });
 *         const apiKey = secret.data.data.apiKey as Redacted.Redacted<string>;
 *         return yield* HttpServerResponse.json({ length: Redacted.value(apiKey).length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving an instance to another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Creates an empty instance in the other project, then deletes the old one
 * // and every secret in it. An explicit `name` deletes the old instance first.
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   projectId: "00000000-0000-0000-0000-000000000003",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Secrets Manager
 * @category SecretsManager
 */
export const Instance = Resource<Instance>("Stackit.SecretsManager.Instance");

const resolveName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: INSTANCE_NAME_MAX_LENGTH });

const toAttrs = (
  projectId: string,
  instance: secretsManager.Instance,
  acls: ReadonlyArray<secretsManager.ACL>,
): InstanceAttributes => ({
  instanceId: instance.id,
  projectId,
  name: instance.name,
  acls: acls.map((acl) => acl.cidr),
  kmsKey: instance.kmsKey,
  apiUrl: instance.apiUrl,
  secretsEngine: instance.secretsEngine,
  secretCount: instance.secretCount,
  state: instance.state,
  creationStartDate: instance.creationStartDate,
  creationFinishedDate: instance.creationFinishedDate,
  updateStartDate: instance.updateStartDate,
  updateFinishedDate: instance.updateFinishedDate,
});

const listProjectInstances = (projectId: string) =>
  secretsManager.listInstances({ projectId }).pipe(Effect.map((list) => list.instances));

const findInstanceByName = (projectId: string, name: string) =>
  listProjectInstances(projectId).pipe(
    Effect.map((instances) => instances.find((instance) => instance.name === name)),
  );

const listAcls = (projectId: string, instanceId: string) =>
  secretsManager.listACLs({ projectId, instanceId }).pipe(Effect.map((list) => list.acls));

const sameKmsKey = (a: InstanceKmsKey | undefined, b: InstanceKmsKey | undefined): boolean =>
  a?.keyId === b?.keyId &&
  a?.keyRingId === b?.keyRingId &&
  a?.keyVersion === b?.keyVersion &&
  a?.serviceAccountEmail === b?.serviceAccountEmail;

/** Add and remove ACL entries until the instance has exactly `desired`. */
const syncAcls = Effect.fn(function* (
  projectId: string,
  instanceId: string,
  desired: ReadonlyArray<string>,
) {
  const observed = yield* listAcls(projectId, instanceId);
  for (const cidr of new Set(desired)) {
    if (observed.some((acl) => acl.cidr === cidr)) continue;
    yield* secretsManager.createACL({ projectId, instanceId, cidr }).pipe(
      // A concurrent add of this range won the race. Any other conflict stands.
      Effect.catchTag("Conflict", (error) =>
        listAcls(projectId, instanceId).pipe(
          Effect.flatMap((acls) =>
            acls.some((acl) => acl.cidr === cidr) ? Effect.void : Effect.fail(error),
          ),
        ),
      ),
    );
  }
  // Removes last, so a sync never leaves the instance narrower than both lists.
  for (const acl of observed) {
    if (desired.includes(acl.cidr)) continue;
    yield* secretsManager
      .deleteACL({ projectId, instanceId, aclId: acl.id })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }
});

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "creationStartDate"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const instances = yield* listProjectInstances(env.projectId);
      const generated = instances.filter((instance) =>
        isGeneratedPhysicalName(instance.name, INSTANCE_NAME_MAX_LENGTH),
      );
      return yield* Effect.forEach(
        generated,
        (instance) =>
          listAcls(env.projectId, instance.id).pipe(
            Effect.map((acls) => toAttrs(env.projectId, instance, acls)),
          ),
        { concurrency: 4 },
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name is the only thing telling two generations apart, so a
      // replacement that keeps it deletes the old instance first. A generated name
      // carries the generation.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const env = yield* StackitEnvironment.current;
      if ((resolved.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace", deleteFirst: resolved.name !== undefined } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      let instance: secretsManager.Instance | undefined;
      if (output?.instanceId !== undefined) {
        instance = yield* getInstanceOrUndefined(projectId, output.instanceId);
      }
      if (instance === undefined && output === undefined) {
        // A generated name holds the instance id, so it finds this generation
        // only; an explicit name can match someone else's instance.
        const name = yield* resolveName(id, olds?.name);
        instance = yield* findInstanceByName(projectId, name);
      }
      if (instance === undefined) return undefined;
      const acls = yield* listAcls(projectId, instance.id);
      const attrs = toAttrs(projectId, instance, acls);
      if (output !== undefined || olds?.name === undefined) return attrs;
      return previous?.instanceId === instance.id ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const generated = yield* resolveName(id, undefined);
      const name = news.name ?? output?.name ?? generated;

      // 1. Observe: `output` is a cache, valid only in the desired project. Only
      // this generation's generated name finds the instance otherwise: it holds
      // the instance id, and instance names aren't otherwise unique.
      let instance: secretsManager.Instance | undefined;
      if (output?.projectId === projectId) {
        instance = yield* getInstanceOrUndefined(projectId, output.instanceId);
      }
      if (instance === undefined && name === generated) {
        instance = yield* findInstanceByName(projectId, name);
      }

      // 2. Ensure
      const created =
        instance ??
        (yield* secretsManager.createInstance({
          projectId,
          name,
          ...(news.kmsKey !== undefined ? { kmsKey: news.kmsKey } : {}),
        }));
      const instanceId = created.id;

      // `createInstance` answers before provisioning finishes. `state` is an
      // undocumented string, so the finish date is what's waited on.
      const ready = yield* waitFor({
        resource: `STACKIT Secrets Manager instance ${instanceId}`,
        read: secretsManager.getInstance({ projectId, instanceId }),
        ready: (observed) => (observed.creationFinishedDate ?? "") !== "",
        state: (observed) => observed.state,
        timeout: INSTANCE_READY_TIMEOUT,
      });

      // 3. Sync: ACLs against the observed list, name and key against the
      // observed instance. PUT replaces, so it always carries the live key.
      if (news.acls !== undefined) yield* syncAcls(projectId, instanceId, news.acls);
      const kmsKey = news.kmsKey ?? ready.kmsKey;
      if (ready.name !== name || !sameKmsKey(ready.kmsKey, kmsKey)) {
        yield* retryConflict(
          secretsManager.updateInstance({
            projectId,
            instanceId,
            name,
            ...(kmsKey !== undefined ? { kmsKey } : {}),
          }),
        );
      }

      // 4. Return
      const final = yield* secretsManager.getInstance({ projectId, instanceId });
      const acls = yield* listAcls(projectId, instanceId);
      return toAttrs(projectId, final, acls);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* secretsManager
        .deleteInstance({ projectId: output.projectId, instanceId: output.instanceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
