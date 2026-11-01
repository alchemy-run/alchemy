import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { desiredLabels, hasAlchemyLabels, labelRecord } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { getInstanceOrUndefined, withDeployVault } from "./internal.ts";

export interface SecretProps {
  /**
   * Instance holding the secret, e.g. a `Stackit.SecretsManager.Instance`'s
   * `instanceId`. Changing it replaces the secret.
   */
  instanceId: string;
  /**
   * Path of the secret in the instance, which may contain `/`. Changing it
   * replaces the secret: the new path is written first, then the old one is
   * permanently removed. If omitted, a unique path is generated from the stack,
   * stage and logical ID.
   */
  path?: string;
  /**
   * The key-value pairs of the secret, each `Redacted`. A change writes a new
   * version. Keep it out of logs by building values with `Redacted.make` or
   * `Config.Redacted`.
   *
   * Alchemy records the props of every resource in its state store, and a
   * `Redacted` value is written there unencrypted, under a `__redacted__` marker.
   * So anyone who can read your state can read these values: use a state store
   * you would trust with them.
   */
  data: Record<string, Redacted.Redacted<string>>;
  /**
   * How many versions to keep. When omitted, the live setting is left alone,
   * and a new secret takes the instance's default.
   */
  maxVersions?: number;
  /**
   * Project of the instance. Defaults to the profile's project. Changing it
   * replaces the secret.
   */
  projectId?: string;
}

export interface SecretAttributes {
  /** Path of the secret in the instance. */
  path: string;
  /** Instance holding the secret. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** URL of the instance's Vault API. */
  apiUrl: string;
  /** The current version. */
  version: number;
  /** The names of the secret's keys. The values are never kept in attributes. */
  keys: string[];
}

export type Secret = Resource<
  "Stackit.SecretsManager.Secret",
  SecretProps,
  SecretAttributes,
  never,
  Providers
>;

/**
 * A secret in a STACKIT Secrets Manager instance, written at deploy time: a KV
 * v2 entry whose values are versioned. Read it at runtime through a binding such
 * as `Stackit.SecretsManager.ReadSecret`.
 *
 * **The machine running `alchemy deploy` has to be inside the instance's `acls`**,
 * since a deploy talks to the instance's Vault API. Vault doesn't take a STACKIT
 * token, so each deploy, and each plan for a secret with no state, creates a
 * short-lived AppRole, uses it, and deletes it.
 *
 * Attributes never hold values, only the key names and the current version.
 * The values are in the `data` prop, and Alchemy records props in its state store
 * unencrypted, under a `__redacted__` marker, as it does for every provider's
 * `Redacted` props. Use a state store you would trust with them.
 *
 * Ownership is tracked in the secret's `custom_metadata`
 * (`alchemy.stack`, `alchemy.stage`, `alchemy.id`). A secret at the same path
 * without them is reported as unowned and only taken over with `--adopt`.
 * Deleting the resource permanently removes every version, and STACKIT can't
 * restore a secret. Secrets go with their instance, so there is no `list`.
 *
 * ### Creating a Secret
 * **Example:** A secret with a generated path
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["203.0.113.7/32"],
 * });
 * const apiKey = yield* Config.redacted("PAYMENTS_API_KEY");
 * const secret = yield* Stackit.SecretsManager.Secret("PaymentsApi", {
 *   instanceId: vault.instanceId,
 *   data: { apiKey },
 * });
 * ```
 *
 * **Example:** A secret at a path you choose
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["203.0.113.7/32"],
 * });
 * const secret = yield* Stackit.SecretsManager.Secret("Database", {
 *   instanceId: vault.instanceId,
 *   path: "payments/database",
 *   data: {
 *     username: Redacted.make("app"),
 *     password: Redacted.make("not-a-real-password"),
 *   },
 *   maxVersions: 5,
 * });
 * ```
 *
 * ### Reading It at Runtime
 * **Example:** Read the secret from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   // A Worker has no stable egress address.
 *   acls: ["0.0.0.0/0"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getSecret = yield* Stackit.SecretsManager.GetSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* getSecret({ secretPath: "payments/database" });
 *         return yield* HttpServerResponse.json({
 *           version: secret.data.metadata.version,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetSecretHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the path
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const vault = yield* Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["203.0.113.7/32"],
 * });
 * // Moving the path writes the secret at the new path, then permanently
 * // removes the old path and all its versions.
 * const secret = yield* Stackit.SecretsManager.Secret("Database", {
 *   instanceId: vault.instanceId,
 *   path: "payments/database-v2",
 *   data: { password: Redacted.make("not-a-real-password") },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Secrets Manager
 * @category SecretsManager
 */
export const Secret = Resource<Secret>("Stackit.SecretsManager.Secret");

/** Generated secret paths. KV has no documented limit; this keeps them readable. */
const PATH_MAX_LENGTH = 128;

const resolvePath = (id: string, path: string | undefined) =>
  path !== undefined
    ? Effect.succeed(path)
    : createPhysicalName({ id, lowercase: true, maxLength: PATH_MAX_LENGTH });

const getMetadataOrUndefined = (mount: string, secretPath: string) =>
  kv.getSecretMetadata({ mount, secretPath }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The current version's data. Missing, or deleted out of band: `undefined`. */
const getCurrentDataOrUndefined = (mount: string, secretPath: string) =>
  kv.getSecret({ mount, secretPath }).pipe(
    Effect.map(({ data }) => data.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const plain = (value: unknown): unknown =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Whether the secret already holds exactly these values. */
const sameData = (
  observed: kv.SecretData | undefined,
  desired: Record<string, Redacted.Redacted<string>>,
): boolean => {
  if (observed === undefined) return false;
  const keys = Object.keys(desired);
  return (
    Object.keys(observed).length === keys.length &&
    keys.every((key) => plain(observed[key]) === Redacted.value(desired[key]!))
  );
};

const observedLabels = (metadata: kv.SecretMetadata | undefined) =>
  labelRecord(metadata?.custom_metadata);

const toAttrs = (
  location: { readonly projectId: string; readonly instanceId: string; readonly apiUrl: string },
  path: string,
  version: number,
  keys: ReadonlyArray<string>,
): SecretAttributes => ({
  path,
  instanceId: location.instanceId,
  projectId: location.projectId,
  apiUrl: location.apiUrl,
  version,
  keys: [...keys].sort(),
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["path", "instanceId", "projectId"],
    // Secrets go with their instance, so nuking the instance is enough.
    nuke: { dependsOn: ["Stackit.SecretsManager.Instance"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved identity can resolve to the explicit path the secret already
      // has, and a path holds one secret: delete the old one first. A generated
      // path carries the generation, so it never collides.
      if (hasUnresolvedTrigger<SecretProps>(news, ["instanceId", "projectId", "path"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<SecretProps>(news, "path") !== undefined,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? env.projectId;
      const path = news.path ?? output.path;
      // A resolved move can't collide with the old secret: another instance or
      // another path. So the new one is written before the old one is destroyed.
      if (
        news.instanceId !== output.instanceId ||
        projectId !== output.projectId ||
        path !== output.path
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A new `data` is an update (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const instance = yield* getInstanceOrUndefined(projectId, instanceId);
      if (instance === undefined) return undefined;
      const { apiUrl } = instance;
      const path = output?.path ?? (yield* resolvePath(id, olds?.path));
      const metadata = yield* withDeployVault(
        { projectId, instanceId, apiUrl, write: false },
        getMetadataOrUndefined(instanceId, path),
      );
      if (metadata === undefined) return undefined;
      const attrs = toAttrs(
        { projectId, instanceId, apiUrl },
        path,
        metadata.current_version,
        output?.keys ?? [],
      );
      if (output !== undefined) return attrs;
      if (previous?.path === path && previous.instanceId === instanceId) return attrs;
      return (yield* hasAlchemyLabels(id, observedLabels(metadata))) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const { instanceId } = news;
      const path = news.path ?? output?.path ?? (yield* resolvePath(id, undefined));
      const labels = yield* desiredLabels(id, undefined);

      const { apiUrl } = yield* secretsManager.getInstance({ projectId, instanceId });

      return yield* withDeployVault(
        { projectId, instanceId, apiUrl, write: true },
        Effect.gen(function* () {
          // 1. Observe: the live value and metadata, never `olds`.
          const observed = yield* getCurrentDataOrUndefined(instanceId, path);
          const metadata = yield* getMetadataOrUndefined(instanceId, path);

          // 2. Ensure + 3. Sync the value: a new version only when it differs.
          let version = metadata?.current_version;
          if (version === undefined || !sameData(observed, news.data)) {
            const written = yield* kv.putSecret({
              mount: instanceId,
              secretPath: path,
              data: news.data,
            });
            version = written.data.version;
          }

          // 3. Sync the metadata against what's there. POST leaves fields it
          // doesn't carry alone, and foreign `custom_metadata` stays.
          const custom = observedLabels(metadata);
          const merged = { ...custom, ...labels };
          if (
            !recordsEqual(custom, merged) ||
            (news.maxVersions !== undefined && metadata?.max_versions !== news.maxVersions)
          ) {
            yield* kv.putSecretMetadata({
              mount: instanceId,
              secretPath: path,
              custom_metadata: merged,
              ...(news.maxVersions !== undefined ? { max_versions: news.maxVersions } : {}),
            });
          }

          // 4. Return
          return toAttrs({ projectId, instanceId, apiUrl }, path, version, Object.keys(news.data));
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, instanceId, path } = output;
      // An instance that's gone took its secrets with it.
      const instance = yield* getInstanceOrUndefined(projectId, instanceId);
      if (instance === undefined) return;
      yield* withDeployVault(
        { projectId, instanceId, apiUrl: instance.apiUrl, write: true },
        kv
          .deleteSecretMetadata({ mount: instanceId, secretPath: path })
          .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      );
    }),
  });
