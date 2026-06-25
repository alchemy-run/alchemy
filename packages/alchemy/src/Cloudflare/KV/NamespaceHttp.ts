import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Self } from "../../Self.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { ApiTokenPermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { KVNamespace } from "./Namespace.ts";
import { KVNamespaceError } from "./NamespaceTypes.ts";

export interface KVHttpToken {
  value: Effect.Effect<Redacted.Redacted<string>>;
  accountId: Effect.Effect<string>;
}

export interface KVHttpScope {
  accountId: string;
  namespaceId: string;
}

const KV_HTTP_PERMISSION_GROUPS: ApiTokenPermissionGroupRef[] = [
  "Workers KV Storage Read",
  "Workers KV Storage Write",
];

type PermissionGroup = (typeof KV_HTTP_PERMISSION_GROUPS)[number];

/**
 * Shared scaffolding for the HTTP-backed KV services.
 *
 * Creates a scoped {@link AccountApiToken}, binds its `value` / `accountId`
 * into the host Worker at deploy time, then delegates to `makeClient` with
 * the bound token and the namespace's `namespaceId`.
 */
export const makeHttpKVNamespaceBinding = <Client>(options: {
  permissionGroups: PermissionGroup[];
  makeClient: (
    token: KVHttpToken,
    namespaceId: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;
    const env = yield* CloudflareEnvironment;

    return Effect.fn(function* (namespace: KVNamespace) {
      const { accountId } = yield* env;
      const token = yield* Token(`${self.LogicalId}Token`);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* token.bind`${namespace.LogicalId}`({
          policies: [
            {
              effect: "allow",
              permissionGroups: options.permissionGroups,
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });
      }
      const bound = {
        value: yield* token.value,
        accountId: yield* token.accountId,
      } satisfies KVHttpToken;
      const namespaceId = yield* namespace.namespaceId;
      return options.makeClient(bound, namespaceId);
    });
  });

/** Resolve the account and namespace id once per operation. */
export const makeKVHttpScope = (
  token: KVHttpToken,
  namespaceId: Effect.Effect<string>,
): Effect.Effect<KVHttpScope> =>
  Effect.gen(function* () {
    const accountId = yield* token.accountId;
    const id = yield* namespaceId;
    return { accountId, namespaceId: id };
  });

export const toKVNamespaceError = (error: unknown): KVNamespaceError =>
  new KVNamespaceError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown KV error",
    cause: error instanceof Error ? error : new Error(String(error)),
  });
