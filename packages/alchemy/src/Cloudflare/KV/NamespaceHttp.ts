import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Self } from "../../Self.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceError } from "./NamespaceTypes.ts";

/**
 * Shared scaffolding for the HTTP-backed KV services.
 *
 * Creates a scoped {@link AccountApiToken}, binds its `value` / `accountId`
 * into the host Worker at deploy time, then delegates to `makeClient` with
 * the bound token and the namespace's `namespaceId`.
 */
export const makeHttpKVNamespaceBinding = <Client>(options: {
  permissionGroups: PermissionGroup[];
  makeClient: (token: HttpToken, namespaceId: Effect.Effect<string>) => Client;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;
    const env = yield* CloudflareEnvironment;

    return Effect.fn(function* (namespace: Namespace) {
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
      } satisfies HttpToken;
      const namespaceId = yield* namespace.namespaceId;
      return options.makeClient(bound, namespaceId);
    });
  });

export interface HttpToken {
  value: Effect.Effect<Redacted.Redacted<string>>;
  accountId: Effect.Effect<string>;
}

export interface HttpScope {
  accountId: string;
  namespaceId: string;
}

const KV_HTTP_PERMISSION_GROUPS: PermissionGroupRef[] = [
  "Workers KV Storage Read",
  "Workers KV Storage Write",
];

type PermissionGroup = (typeof KV_HTTP_PERMISSION_GROUPS)[number];

/** Resolve the account and namespace id once per operation. */
export const makeKVHttpScope = (
  token: HttpToken,
  namespaceId: Effect.Effect<string>,
): Effect.Effect<HttpScope> =>
  Effect.gen(function* () {
    const accountId = yield* token.accountId;
    const id = yield* namespaceId;
    return { accountId, namespaceId: id };
  });

export const toKVNamespaceError = (error: unknown): NamespaceError =>
  new NamespaceError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown KV error",
    cause: error instanceof Error ? error : new Error(String(error)),
  });
