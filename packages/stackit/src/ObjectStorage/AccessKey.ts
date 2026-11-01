import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled, GROUP_NAME_MAX_LENGTH, toRedacted } from "./internal.ts";

export interface AccessKeyProps {
  /**
   * Credentials group to create the key in (a
   * {@link CredentialsGroup}'s `credentialsGroupId`). If omitted, the key
   * is created in the project's `default` credentials group. Changing it
   * replaces the key.
   */
  credentialsGroupId?: string;
  /**
   * Expiration timestamp (RFC 3339, e.g. `2027-01-01T00:00:00Z`). If
   * omitted, the key never expires. Changing it replaces the key.
   */
  expires?: string;
  /**
   * Project to create the key in. Defaults to the profile's project.
   * Changing it replaces the key.
   */
  projectId?: string;
  /**
   * Region of the key. Defaults to the profile's region (`eu01`).
   * Changing it replaces the key.
   */
  region?: string;
}

export type AccessKey = Resource<
  "Stackit.ObjectStorage.AccessKey",
  AccessKeyProps,
  {
    /** Id of the key pair, used to delete it. */
    keyId: string;
    /** S3 access key id (`AWS_ACCESS_KEY_ID` for S3 clients). */
    accessKeyId: string;
    /**
     * S3 secret access key (`AWS_SECRET_ACCESS_KEY`). STACKIT returns it
     * only when the key is created; Alchemy keeps it in state.
     */
    secretAccessKey: Redacted.Redacted<string>;
    /** Obfuscated access key shown by STACKIT. */
    displayName: string;
    /** Expiration timestamp, or `undefined` when the key never expires. */
    expires: string | undefined;
    /** Credentials group of the key; `undefined` for the project's `default` group. */
    credentialsGroupId: string | undefined;
    /** Project the key belongs to. */
    projectId: string;
    /** Region of the key. */
    region: string;
  },
  never,
  Providers
>;

/**
 * A STACKIT Object Storage access key: an S3 access key id and secret for
 * a {@link CredentialsGroup}. The secret is returned once, when the key is
 * created, and kept in Alchemy state as a `Redacted` value.
 *
 * Nothing about a key is mutable: every prop change creates a new key and
 * deletes the old one. If the key is deleted outside Alchemy, the next
 * deploy creates a new one with a new secret.
 *
 * Ownership: access keys have no name or labels, so a key is identified
 * only by the `keyId` in state. `alchemy unsafe nuke` lists the keys inside
 * credentials groups Alchemy owns (generated names) and deletes them before
 * those groups; keys in the `default` group are never enumerated.
 *
 * See [STACKIT's Object Storage docs](https://docs.stackit.cloud/products/storage/object-storage/).
 *
 * :::caution[Changing `credentialsGroupId`, `expires`, `projectId` or `region` replaces the Key]
 * A deploy creates a new key with a new secret; update every consumer of the old
 * secret.
 * :::
 *
 * ### Creating an Access Key
 * **Example:** Key in a dedicated credentials group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.ObjectStorage.CredentialsGroup("Uploaders", {});
 * const key = yield* Stackit.ObjectStorage.AccessKey("UploaderKey", {
 *   credentialsGroupId: group.credentialsGroupId,
 * });
 * ```
 *
 * **Example:** Expiring key in the project's default group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const key = yield* Stackit.ObjectStorage.AccessKey("TemporaryKey", {
 *   expires: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * ### Using the key with S3 clients
 * **Example:** Pass the credentials to a workload
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Uploads", {});
 * const group = yield* Stackit.ObjectStorage.CredentialsGroup("Uploaders", {});
 * const key = yield* Stackit.ObjectStorage.AccessKey("UploaderKey", {
 *   credentialsGroupId: group.credentialsGroupId,
 * });
 * // key.accessKeyId and key.secretAccessKey (Redacted) are the S3
 * // credentials; bucket.urlVirtualHostedStyle is the bucket's endpoint.
 * ```
 *
 * @resource
 * @product STACKIT Object Storage
 * @category Storage
 */
export const AccessKey = Resource<AccessKey>("Stackit.ObjectStorage.AccessKey");

type Attributes = AccessKey["Attributes"];

const listKeys = (projectId: string, region: string, credentialsGroupId: string | undefined) =>
  objectStorage
    .listAccessKeys({ projectId, region, credentials_group: credentialsGroupId })
    .pipe(Effect.map((response) => response.accessKeys));

/** Observe a key by id inside its group; `undefined` when it is gone. */
const findKey = (
  projectId: string,
  region: string,
  credentialsGroupId: string | undefined,
  keyId: string,
) =>
  listKeys(projectId, region, credentialsGroupId).pipe(
    Effect.map((keys) => keys.find((key) => key.keyId === keyId)),
    // The group (or the project's Object Storage tenant) is gone, and the
    // key with it.
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const deleteKey = (
  projectId: string,
  region: string,
  credentialsGroupId: string | undefined,
  keyId: string,
) =>
  objectStorage
    .deleteAccessKey({ projectId, region, keyId, credentials_group: credentialsGroupId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

export const AccessKeyProvider = () =>
  Provider.succeed(AccessKey, {
    stables: [
      "keyId",
      "accessKeyId",
      "secretAccessKey",
      "credentialsGroupId",
      "projectId",
      "region",
    ],
    // Deleting a key needs its credentials group; a group can't be deleted
    // while it holds keys. Nuke deletes keys first.
    nuke: { dependsOn: ["Stackit.ObjectStorage.CredentialsGroup"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<AccessKeyProps>(news, [
          "credentialsGroupId",
          "expires",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace" as const };
      }
      const resolved = triggerProps<AccessKeyProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.credentialsGroupId !== output.credentialsGroupId ||
        (olds !== undefined && resolved.expires !== olds.expires) ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // A key has no name to look up: without state there is no identity.
      if (output === undefined) return undefined;
      const key = yield* findKey(
        output.projectId,
        output.region,
        output.credentialsGroupId,
        output.keyId,
      );
      if (key === undefined) return undefined;
      return {
        ...output,
        displayName: key.displayName,
        expires: key.expires ?? undefined,
      } satisfies Attributes;
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const groups = yield* objectStorage
        .listCredentialsGroups({ projectId: env.projectId, region: env.region })
        .pipe(
          Effect.map((response) => response.credentialsGroups),
          // The project was never enabled for Object Storage: no keys.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
      const perGroup = yield* Effect.forEach(
        groups.filter((group) => isGeneratedPhysicalName(group.displayName, GROUP_NAME_MAX_LENGTH)),
        (group) =>
          listKeys(env.projectId, env.region, group.credentialsGroupId).pipe(
            Effect.map((keys) =>
              keys.map((key): Attributes => ({
                keyId: key.keyId,
                // Listing never returns the key itself or its secret; the
                // result only feeds `delete`, which needs neither.
                accessKeyId: "",
                secretAccessKey: Redacted.make(""),
                displayName: key.displayName,
                expires: key.expires ?? undefined,
                credentialsGroupId: group.credentialsGroupId,
                projectId: env.projectId,
                region: env.region,
              })),
            ),
          ),
        { concurrency: 4 },
      );
      return perGroup.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const credentialsGroupId = news.credentialsGroupId;

      yield* ensureObjectStorageEnabled({ projectId, region });

      // 1. Observe: the cached key counts only if it is still in the
      //    desired group, project and region.
      const sameIdentity =
        output !== undefined &&
        output.projectId === projectId &&
        output.region === region &&
        output.credentialsGroupId === credentialsGroupId;
      if (output !== undefined && sameIdentity) {
        const existing = yield* findKey(projectId, region, credentialsGroupId, output.keyId);
        if (existing !== undefined) {
          return {
            ...output,
            displayName: existing.displayName,
            expires: existing.expires ?? undefined,
          } satisfies Attributes;
        }
      }

      // 2. Ensure: create a new key pair (the secret is only returned now).
      const created = yield* objectStorage.createAccessKey({
        projectId,
        region,
        credentials_group: credentialsGroupId,
        expires: news.expires,
      });

      // A key that moved out of its old group/project would otherwise block
      // deleting that group; remove it once its successor exists.
      if (output !== undefined && !sameIdentity) {
        yield* deleteKey(output.projectId, output.region, output.credentialsGroupId, output.keyId);
      }

      return {
        keyId: created.keyId,
        accessKeyId: created.accessKey,
        secretAccessKey: toRedacted(created.secretAccessKey),
        displayName: created.displayName,
        expires: created.expires ?? undefined,
        credentialsGroupId,
        projectId,
        region,
      } satisfies Attributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteKey(output.projectId, output.region, output.credentialsGroupId, output.keyId);
    }),
  });
