import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import { Credentials } from "@distilled.cloud/daytona/Credentials";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import { currentOrganizationId } from "./internal/Organization.ts";
import type { Providers } from "./Providers.ts";

/**
 * A permission an API key or organization role grants. Daytona checks
 * them per kind of object: `write:sandboxes` allows creating any sandbox in
 * the organization, not one in particular.
 */
export type Permission = apiKeys.CreateApiKeyRequestPermissionsItem;

export interface ApiKeyProps {
  /**
   * Key name, unique in the organization. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces
   * the key.
   */
  name?: string;
  /**
   * What the key may do. Changing them replaces the key, since Daytona
   * keys can't be edited.
   */
  permissions: Permission[];
  /**
   * When the key stops working, as an ISO 8601 timestamp. Changing it
   * replaces the key.
   */
  expiresAt?: string;
}

export interface ApiKeyAttributes {
  /** Key name. */
  name: string;
  /** Permissions the key grants. */
  permissions: Permission[];
  /** When the key expires, if it does. */
  expiresAt: string | undefined;
  /** When the key was created. */
  createdAt: string;
  /** The Daytona API root the key belongs to. */
  apiBaseUrl: string;
  /** The organization the key acts on. */
  organizationId: string;
  /**
   * The key itself, sent as `Authorization: Bearer <value>`. Daytona shows
   * it only when the key is created, so alchemy keeps it in state.
   */
  value: Redacted.Redacted<string>;
}

export type ApiKey = Resource<"Daytona.ApiKey", ApiKeyProps, ApiKeyAttributes, never, Providers>;

/**
 * A Daytona API key with a fixed set of permissions. Give each app the
 * narrowest key it needs; Daytona checks every request against it.
 *
 * The runtime bindings (`Daytona.CreateSandbox`, `Daytona.CreateVolume`, …)
 * mint one of these per host for you, with only the permissions the
 * binding needs. Declare one yourself for CI or for a program outside
 * alchemy.
 *
 * Daytona shows a key's value only once, so alchemy stores it in state as
 * a `Redacted` value. Keys can't be edited: changing any prop mints a new
 * key and deletes the old one.
 *
 * Creating keys needs a signed-in profile, or an API key with
 * `manage:api_keys` (Daytona's managed API keys, enabled on request);
 * otherwise Daytona refuses with `ManagedApiKeysNotEnabled`.
 * @see https://www.daytona.io/docs/en/api-keys/
 *
 * ### Creating a Key
 * **Example:** A key that can only create and delete sandboxes
 * ```typescript
 * const key = yield* Daytona.ApiKey("Ci", {
 *   permissions: ["write:sandboxes", "delete:sandboxes"],
 * });
 * ```
 *
 * **Example:** A key that expires
 * ```typescript
 * const key = yield* Daytona.ApiKey("Preview", {
 *   permissions: ["write:sandboxes"],
 *   expiresAt: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * @resource
 * @product API Key
 */
export const ApiKey = Resource<ApiKey>("Daytona.ApiKey");

/** Daytona created a key but returned no value for it. */
export class ApiKeyValueMissing extends Data.TaggedError("Daytona.ApiKeyValueMissing")<{
  readonly keyName: string;
}> {
  override get message() {
    return `Daytona returned no value for the new API key ${this.keyName}`;
  }
}

const sorted = (permissions: readonly string[]) => [...permissions].sort();

const apiRoot = Effect.gen(function* () {
  const credentials = yield* Credentials;
  return (yield* credentials).apiBaseUrl;
});

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      const getKey = (name: string) =>
        apiKeys.getApiKey({ name }).pipe(Effect.catchTag("ApiKeyNotFound", () => Effect.undefined));
      const deleteKey = (name: string) =>
        apiKeys.deleteApiKey({ name }).pipe(Effect.catchTag("ApiKeyNotFound", () => Effect.void));

      return {
        stables: ["name", "createdAt", "value"],
        list: Effect.fn(function* () {
          const keys = yield* apiKeys.listApiKeys({});
          const apiBaseUrl = yield* apiRoot;
          return keys.map((key) => ({
            name: key.name,
            permissions: key.permissions,
            expiresAt: key.expiresAt ?? undefined,
            createdAt: key.createdAt,
            apiBaseUrl,
            organizationId: key.organizationId ?? "",
            value: Redacted.make(""),
          }));
        }),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const name = yield* resolveName(
            id,
            news.name,
            olds?.name === news.name ? output.name : undefined,
          );
          if (
            name !== output.name ||
            !deepEqual(sorted(news.permissions), sorted(output.permissions)) ||
            (news.expiresAt ?? undefined) !== (olds?.expiresAt ?? undefined)
          ) {
            // A pinned name can't be held by two keys at once.
            return { action: "replace", deleteFirst: name === output.name } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* resolveName(id, olds?.name, output?.name);
          const observed = yield* getKey(name);
          if (observed === undefined) return undefined;
          const attrs = {
            name: observed.name,
            permissions: observed.permissions,
            expiresAt: observed.expiresAt ?? undefined,
            createdAt: observed.createdAt,
            apiBaseUrl: output?.apiBaseUrl ?? (yield* apiRoot),
            organizationId: output?.organizationId ?? (yield* currentOrganizationId),
            value: output?.value ?? Redacted.make(""),
          };
          // The value is only shown at creation, so a key with no state
          // can't be adopted with it; reconcile re-mints it.
          return (yield* isOwnedName(id, name, output !== undefined)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* resolveName(id, news.name, output?.name);

          // Observe
          const observed = yield* getKey(name);
          if (
            observed !== undefined &&
            output !== undefined &&
            Redacted.value(output.value) !== ""
          ) {
            return {
              ...output,
              permissions: observed.permissions,
              expiresAt: observed.expiresAt ?? undefined,
            };
          }

          // Ensure: a key whose value we don't hold (lost create, adoption)
          // is deleted and minted again.
          if (observed !== undefined) {
            yield* session.note(`Re-minting Daytona API key ${name}...`);
            yield* deleteKey(name);
          }
          const created = yield* apiKeys.createApiKey({
            name,
            permissions: news.permissions,
            expiresAt: news.expiresAt,
          });
          const value = Redacted.isRedacted(created.value)
            ? created.value
            : Redacted.make(created.value);
          if (Redacted.value(value) === "") return yield* new ApiKeyValueMissing({ keyName: name });
          return {
            name: created.name,
            permissions: created.permissions,
            expiresAt: created.expiresAt ?? undefined,
            createdAt: created.createdAt,
            apiBaseUrl: yield* apiRoot,
            organizationId: yield* currentOrganizationId,
            value,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteKey(output.name);
        }),
      };
    }),
  );
