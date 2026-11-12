import * as apiKeys from "@distilled.cloud/clickhouse-cloud/api_keys";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/clickhouse-cloud/Credentials";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ApiKeyInUse, requireResult, ResultMissing } from "../Errors.ts";
import { isGeneratedName, isOwnedName, resolveName } from "../internal/Names.ts";
import type { Providers } from "../Providers.ts";

/** One address allowed to use a key. */
export interface ApiKeyIpAccessEntry {
  /** An IPv4 address or CIDR. */
  source: string;
  /** What the entry is for. */
  description?: string;
}

/** Hashes of a key ID and secret you generated yourself, so the secret never travels. */
export interface ApiKeyHashData {
  /** base64(SHA-256(key ID)). */
  keyIdHash: string;
  /** Last 4 characters of the key ID. */
  keyIdSuffix: string;
  /** base64(SHA-256(key secret)). */
  keySecretHash: Redacted.Redacted<string>;
}

/** A role assigned to a key. */
export interface AssignedRole {
  /** Role ID. */
  roleId: string;
  /** Role name. */
  roleName: string | undefined;
  /** `system` (predefined) or `custom`. */
  roleType: string | undefined;
}

export interface ApiKeyProps {
  /**
   * Key name. If omitted, a unique name is generated from the stack, stage
   * and logical ID. Changing it renames the key in place.
   */
  name?: string;
  /**
   * IDs of the roles the key acts with: system roles, or
   * `ClickHouseCloud.RoleManagement.Role` IDs. At least one: organizations
   * on custom roles (V2) refuse a key without a role. Alchemy adds these
   * to the key and removes the ones you drop from this list; roles that
   * list the key in their `actors` stay assigned.
   */
  assignedRoleIds: string[];
  /**
   * When the key stops working, as an ISO 8601 timestamp. Omit for a key
   * that never expires.
   */
  expireAt?: string;
  /**
   * Whether the key works.
   * @default "enabled"
   */
  state?: "enabled" | "disabled";
  /**
   * Addresses allowed to use the key. Omit to allow any address.
   */
  ipAccessList?: ApiKeyIpAccessEntry[];
  /**
   * Hashes of a key ID and secret you generated yourself. ClickHouse then
   * never returns a secret, and `keySecret` stays empty. Changing them
   * replaces the key.
   */
  hashData?: ApiKeyHashData;
}

export interface ApiKeyAttributes {
  /** Key ID in the API's paths (`/keys/{id}`). */
  id: string;
  /** Organization that owns the key. */
  organizationId: string;
  /** Key ID sent as the Basic-auth username. Returned only at creation. */
  keyId: string;
  /**
   * Key secret sent as the Basic-auth password. ClickHouse returns it only
   * at creation, so alchemy keeps it in state. Empty when `hashData` was
   * used.
   */
  keySecret: Redacted.Redacted<string>;
  /**
   * Cloud API origin the key was created against: the profile's
   * `apiBaseUrl` (or `CLICKHOUSE_CLOUD_API_URL`). Binding hosts call it.
   */
  apiBaseUrl: string;
  /** Key name. */
  name: string;
  /** `enabled` or `disabled`. */
  state: string | undefined;
  /** Roles the key acts with. */
  assignedRoles: AssignedRole[];
  /** Last 4 characters of the key ID. */
  keySuffix: string | undefined;
  /** When the key was created. */
  createdAt: string | undefined;
  /** When the key expires, if it does. */
  expireAt: string | undefined;
  /** When the key was last used, to the minute. */
  usedAt: string | undefined;
  /** Addresses allowed to use the key. */
  ipAccessList: ApiKeyIpAccessEntry[];
}

export type ApiKey = Resource<
  "ClickHouseCloud.ApiKeys.ApiKey",
  ApiKeyProps,
  ApiKeyAttributes,
  never,
  Providers
>;

/**
 * A ClickHouse Cloud organization API key: the key ID and secret the Cloud
 * API authenticates with (HTTP Basic).
 *
 * ClickHouse returns the secret only when the key is created, so alchemy
 * keeps it in state as a `Redacted` value. Every other prop updates the
 * key in place; only `hashData` replaces it.
 *
 * A key is created with its roles: organizations on custom roles (V2)
 * answer `'assignedRoleIds' is required` for a key without one. Declare
 * the `ClickHouseCloud.RoleManagement.Role` first and pass its `roleId`;
 * a role can also add an existing key through its `actors` afterwards.
 * Give a key the narrowest roles it needs: a role with policies on one
 * service, or a system role.
 *
 * Keys have no tags, so a generated name is the ownership marker:
 * `alchemy unsafe nuke` only deletes keys whose name has the shape alchemy
 * generates. A key never deletes the key the deploy authenticates with.
 * @see https://clickhouse.com/docs/cloud/manage/openapi
 *
 * ### Creating a Key
 * **Example:** A key with a custom role
 * ```typescript
 * const reader = yield* ClickHouseCloud.RoleManagement.Role("Reader", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view"],
 *       resources: ["instance/*"],
 *     },
 *   ],
 * });
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Ci", {
 *   assignedRoleIds: [reader.roleId],
 * });
 * // key.keyId and key.keySecret authenticate the Cloud API
 * ```
 *
 * **Example:** A key that expires and only works from CI
 * ```typescript
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Ci", {
 *   assignedRoleIds: ["<system role id>"],
 *   expireAt: "2027-01-01T00:00:00Z",
 *   ipAccessList: [{ source: "198.51.100.0/24", description: "ci runners" }],
 * });
 * ```
 *
 * ### Disabling a Key
 * **Example:** Keep the key but switch it off
 * ```typescript
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Ci", {
 *   assignedRoleIds: ["<system role id>"],
 *   state: "disabled",
 * });
 * ```
 *
 * @resource
 * @product API Key
 */
export const ApiKey = Resource<ApiKey>("ClickHouseCloud.ApiKeys.ApiKey");

const toAccessList = (entries: apiKeys.IpAccessListEntry[] | undefined): ApiKeyIpAccessEntry[] =>
  (entries ?? []).flatMap((e) =>
    e.source === undefined
      ? []
      : [
          e.description === undefined
            ? { source: e.source }
            : { source: e.source, description: e.description },
        ],
  );

/** The key material state holds: the ID and secret, and the API they authenticate. */
interface KeyMaterial {
  keyId: string;
  keySecret: Redacted.Redacted<string>;
  apiBaseUrl: string;
}

const toAttributes = (
  organizationId: string,
  key: apiKeys.ApiKey,
  secret: KeyMaterial,
): ApiKeyAttributes => ({
  id: key.id ?? "",
  organizationId,
  keyId: secret.keyId,
  keySecret: secret.keySecret,
  apiBaseUrl: secret.apiBaseUrl,
  name: key.name ?? "",
  state: key.state,
  assignedRoles: (key.assignedRoles ?? []).flatMap((r) =>
    r.roleId === undefined
      ? []
      : [{ roleId: r.roleId, roleName: r.roleName, roleType: r.roleType }],
  ),
  keySuffix: key.keySuffix,
  createdAt: key.createdAt,
  expireAt: key.expireAt ?? undefined,
  usedAt: key.usedAt,
  ipAccessList: toAccessList(key.ipAccessList),
});

const sameAccess = (a: ApiKeyIpAccessEntry[], b: ApiKeyIpAccessEntry[]) =>
  deepEqual(
    a.map((e) => `${e.source}\u0000${e.description ?? ""}`).sort(),
    b.map((e) => `${e.source}\u0000${e.description ?? ""}`).sort(),
  );

const sorted = (values: readonly string[]) => [...values].sort();

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      const getKey = (organizationId: string, id: string) =>
        apiKeys.getApiKey({ organizationId, keyId: id }).pipe(
          Effect.flatMap(requireResult("getApiKey")),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
      const findByName = (organizationId: string, name: string) =>
        apiKeys.listApiKeys.items({ organizationId }).pipe(
          Stream.filter((key) => key.name === name),
          Stream.runHead,
          Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
        );
      const deleteKey = (organizationId: string, id: string) =>
        apiKeys
          .deleteApiKey({ organizationId, keyId: id })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      /** The key the deploy authenticates with, and the API it calls. */
      const deployer = Effect.gen(function* () {
        const resolve = yield* Credentials;
        return yield* resolve;
      });

      return {
        stables: ["id", "organizationId", "keyId", "keySecret", "apiBaseUrl", "createdAt"],
        list: Effect.fn(function* () {
          const organizationId = yield* currentOrganizationId;
          const all = yield* apiKeys.listApiKeys.items({ organizationId }).pipe(Stream.runCollect);
          return Array.from(all)
            .filter((key) => key.id !== undefined && isGeneratedName(key.name ?? ""))
            .map((key) =>
              toAttributes(organizationId, key, {
                keyId: "",
                keySecret: Redacted.make(""),
                apiBaseUrl: DEFAULT_API_BASE_URL,
              }),
            );
        }),
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined || olds === undefined) return undefined;
          // Delete first: the new key keeps the old one's name.
          if (!deepEqual(news.hashData, olds.hashData)) {
            return { action: "replace", deleteFirst: true } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const secret = {
            keyId: output?.keyId ?? "",
            keySecret: output?.keySecret ?? Redacted.make(""),
            apiBaseUrl: output?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
          };
          const name = yield* resolveName(id, olds?.name, output?.name);
          const observed = output?.id
            ? yield* getKey(organizationId, output.id)
            : yield* findByName(organizationId, name);
          if (observed === undefined) return undefined;
          const attrs = toAttributes(organizationId, observed, secret);
          // The secret is only shown at creation: a key found without state
          // can't be adopted with it, and reconcile replaces it.
          return (yield* isOwnedName(
            id,
            attrs.name,
            output !== undefined || attrs.id === previous?.id,
          ))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const name = yield* resolveName(id, news.name, output?.name);
          const { apiBaseUrl } = yield* deployer;

          // Observe
          let observed = output?.id
            ? yield* getKey(organizationId, output.id)
            : yield* findByName(organizationId, name);
          // The secret is held only when state has it for this key: an
          // adopted key, or one whose create never reached state, comes with
          // an empty one. With `hashData` the caller holds the secret.
          let secret: KeyMaterial | undefined =
            output !== undefined &&
            observed?.id === output.id &&
            (Redacted.value(output.keySecret) !== "" || news.hashData !== undefined)
              ? { keyId: output.keyId, keySecret: output.keySecret, apiBaseUrl }
              : undefined;

          // A key whose secret alchemy doesn't hold can't be handed to
          // anyone: delete it and create it again.
          if (observed !== undefined && secret === undefined && news.hashData === undefined) {
            yield* session.note(`Re-creating ClickHouse Cloud API key ${name}...`);
            yield* deleteKey(organizationId, observed.id!);
            observed = undefined;
          }

          // Ensure
          if (observed === undefined) {
            const created = yield* apiKeys
              .createApiKey({
                organizationId,
                name,
                expireAt: news.expireAt,
                state: news.state,
                hashData: news.hashData,
                assignedRoleIds: news.assignedRoleIds,
                ipAccessList: news.ipAccessList,
              })
              .pipe(Effect.flatMap(requireResult("createApiKey")));
            if (created.key?.id === undefined) {
              return yield* new ResultMissing({ operation: "createApiKey (key)" });
            }
            observed = created.key;
            const keySecret =
              created.keySecret === undefined
                ? Redacted.make("")
                : Redacted.isRedacted(created.keySecret)
                  ? created.keySecret
                  : Redacted.make(created.keySecret);
            secret = { keyId: created.keyId ?? "", keySecret, apiBaseUrl };
          }
          const keyId = observed.id!;
          // A key created from `hashData` before this state existed: the
          // caller holds its secret, and only the hashes reached ClickHouse.
          const material: KeyMaterial = secret ?? {
            keyId: output?.keyId ?? "",
            keySecret: Redacted.make(""),
            apiBaseUrl,
          };

          // Sync against the observed key. Roles this resource assigned and
          // no longer declares are removed; roles a Role assigned through its
          // `actors` are not this resource's to remove.
          const observedRoleIds = (observed.assignedRoles ?? []).flatMap((r) =>
            r.roleId === undefined ? [] : [r.roleId],
          );
          const dropped = (olds?.assignedRoleIds ?? []).filter(
            (roleId) => !news.assignedRoleIds.includes(roleId),
          );
          const wantedRoleIds = [
            ...new Set([
              ...observedRoleIds.filter((roleId) => !dropped.includes(roleId)),
              ...news.assignedRoleIds,
            ]),
          ];
          const patch: Omit<apiKeys.UpdateApiKeyRequest, "organizationId" | "keyId"> = {
            ...(observed.name !== name ? { name } : {}),
            ...(!deepEqual(sorted(wantedRoleIds), sorted(observedRoleIds))
              ? { assignedRoleIds: wantedRoleIds }
              : {}),
            ...((news.expireAt ?? null) !== (observed.expireAt ?? null)
              ? { expireAt: news.expireAt ?? null }
              : {}),
            ...((news.state ?? "enabled") !== (observed.state ?? "enabled")
              ? { state: news.state ?? "enabled" }
              : {}),
            ...(!sameAccess(news.ipAccessList ?? [], toAccessList(observed.ipAccessList))
              ? { ipAccessList: news.ipAccessList ?? [] }
              : {}),
          };
          if (Object.keys(patch).length > 0) {
            observed = yield* apiKeys
              .updateApiKey({ organizationId, keyId, ...patch })
              .pipe(Effect.flatMap(requireResult("updateApiKey")));
          }

          return toAttributes(organizationId, observed, material);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.keyId !== "" && output.keyId === (yield* deployer).keyId) {
            return yield* new ApiKeyInUse({ keyId: output.keyId });
          }
          yield* deleteKey(output.organizationId, output.id);
        }),
      };
    }),
  );
