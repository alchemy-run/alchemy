import * as archil from "@distilled.cloud/archil";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { account } from "./Credentials.ts";
import { isAlchemyName, tokenName } from "./internal/archil.ts";
import type { Providers } from "./Providers.ts";

export interface ApiTokenProps {
  /**
   * Token name, unique within your account. If omitted, a unique name is
   * generated from the stack, stage, and logical ID. Changing it replaces
   * the token.
   */
  name?: string;
  /** Description shown in the console. Changing it replaces the token. */
  description?: string;
}

export interface ApiTokenAttributes {
  /** Token id. */
  tokenId: string;
  /** Token name. */
  name: string;
  /** Last characters of the key, as shown in the console. */
  tokenSuffix: string | undefined;
  /** The API key (`key-…`). */
  token: Redacted.Redacted<string>;
  /** Archil region the key was created for, e.g. `aws-us-east-1`. */
  region: string;
}

export type ApiToken = Resource<
  "Archil.ApiToken",
  ApiTokenProps,
  ApiTokenAttributes,
  never,
  Providers
>;

/**
 * An Archil API key. It can call the whole control plane of your account:
 * Archil has no scoped keys, so give each app or host its own key and
 * revoke it on its own. To mount one disk, use a {@link DiskUser}, whose
 * token works only for that disk.
 *
 * Archil only shows the key once, when it's created, so Alchemy stores it
 * in state as a `Redacted` value. Changing a prop creates a new key, and
 * destroying it revokes the key.
 *
 * Archil refuses API keys on its API key operations: deploying with one
 * fails with `Unauthorized`, the same error a bad key gets.
 * @see https://docs.archil.com/api-reference
 *
 * ### Creating a Key
 * **Example:** A key for CI
 * ```typescript
 * const key = yield* Archil.ApiToken("Ci", { description: "GitHub Actions" });
 * ```
 *
 * @resource
 * @product API Key
 */
export const ApiToken = Resource<ApiToken>("Archil.ApiToken");

const observe = Effect.fn(function* (match: { tokenId?: string; name: string }) {
  const { data } = yield* archil.listApiTokens({});
  return (data.tokens ?? []).find((token) =>
    match.tokenId !== undefined ? token.id === match.tokenId : token.name === match.name,
  );
});

const revoke = (tokenId: string) =>
  archil.deleteToken({ id: tokenId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

/** Create an API key and return its attributes. */
export const createApiToken = Effect.fn(function* (name: string, description?: string) {
  const { data } = yield* archil.createApiToken({ name, description });
  const { region } = yield* account;
  return {
    tokenId: data.id,
    name,
    tokenSuffix: data.tokenSuffix,
    token: typeof data.token === "string" ? Redacted.make(data.token) : data.token,
    region,
  } satisfies ApiTokenAttributes;
});

export const ApiTokenProvider = () =>
  Provider.effect(
    ApiToken,
    Effect.gen(function* () {
      return {
        stables: ["tokenId", "name", "tokenSuffix", "token", "region"],
        list: Effect.fn(function* () {
          const { region } = yield* account;
          const { data } = yield* archil.listApiTokens({});
          return (data.tokens ?? [])
            .filter((token) => isAlchemyName(token.name))
            .map((token) => ({
              tokenId: token.id ?? "",
              name: token.name ?? "",
              tokenSuffix: token.tokenSuffix,
              token: Redacted.make(""),
              region,
            }));
        }),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* tokenName(id, olds?.name));
          if (
            (news.name !== undefined && news.name !== name) ||
            news.description !== olds?.description
          ) {
            return {
              action: "replace",
              deleteFirst: news.name !== undefined && news.name === name,
            } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const name = output?.name ?? (yield* tokenName(id, olds?.name));
          const observed = yield* observe({ tokenId: output?.tokenId, name });
          if (!observed) return undefined;
          if (output !== undefined && output.tokenId === observed.id) return output;
          if (previous !== undefined && previous.tokenId === observed.id) return previous;
          // The key is only revealed at creation, so a token we have no state
          // for can't be adopted with its value — reconcile re-mints.
          return Unowned({
            tokenId: observed.id ?? "",
            name,
            tokenSuffix: observed.tokenSuffix,
            token: Redacted.make(""),
            region: (yield* account).region,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* tokenName(id, news.name));
          // Observe
          const observed = yield* observe({ tokenId: output?.tokenId, name });
          if (
            observed &&
            output &&
            Redacted.value(output.token) !== "" &&
            output.tokenId === observed.id
          ) {
            return output;
          }
          // Ensure — a key we hold no secret for is revoked and re-minted.
          if (observed?.id) {
            yield* session.note(`Re-minting API token ${name}...`);
            yield* revoke(observed.id);
          }
          return yield* createApiToken(name, news.description);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* revoke(output.tokenId);
        }),
      };
    }),
  );
