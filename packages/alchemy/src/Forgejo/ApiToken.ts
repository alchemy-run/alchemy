import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { ForgejoCredentials, optional, paginate } from "./Client.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Repository restriction for a Forgejo API token.
 */
export interface ApiTokenRepository {
  /**
   * User or organization that owns the repository.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly name: string;
}

/**
 * Desired settings for a Forgejo API token.
 */
export interface ApiTokenProps {
  /**
   * User that owns the generated token.
   */
  readonly username: string;
  /**
   * Human-readable token name.
   */
  readonly name: string;
  /**
   * Permission scopes granted to the token.
   */
  readonly scopes?: readonly string[];
  /**
   * Repositories the token may access. Omit for unrestricted repository
   * access.
   */
  readonly repositories?: readonly ApiTokenRepository[];
}

/**
 * Observed attributes of a Forgejo API token.
 */
export interface ApiTokenAttributes {
  /**
   * Stable numeric token identifier.
   */
  readonly tokenId: number;
  /**
   * Generated bearer token. Forgejo only returns this value during creation.
   */
  readonly token: Redacted.Redacted<string>;
  /**
   * Last eight characters of the generated token.
   */
  readonly tokenLastEight: string;
  /**
   * Token creation timestamp.
   */
  readonly createdAt: string;
}

/**
 * A Forgejo API access-token resource.
 */
export interface ApiToken extends Resource<
  "Forgejo.ApiToken",
  ApiTokenProps,
  ApiTokenAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * An API access token for a Forgejo user.
 *
 * Creating one uses Forgejo's admin user-token endpoints, so the provider
 * credential must belong to an administrator. Forgejo returns the token's
 * plaintext only in the create response: it is exposed as a redacted output
 * and can never be recovered afterwards, so any change to the token's
 * identity or scopes replaces it.
 *
 * ### Creating a Token
 * **Example:** Basic Token
 * ```typescript
 * const token = yield* Forgejo.ApiToken("ci", {
 *   username: "ci-bot",
 *   name: "ci",
 * });
 * ```
 *
 * **Example:** Scoped, Repository-Restricted Token
 * ```typescript
 * yield* Forgejo.ApiToken("deploy", {
 *   username: "ci-bot",
 *   name: "deploy",
 *   scopes: ["write:repository", "read:organization"],
 *   repositories: [{ owner: "acme", name: "api" }],
 * });
 * ```
 *
 * ### Passing the Token On
 * **Example:** Store the Token as an Actions Secret
 * ```typescript
 * const token = yield* Forgejo.ApiToken("ci", {
 *   username: "ci-bot",
 *   name: "ci",
 * });
 *
 * yield* Forgejo.Secret("forgejo-token", {
 *   owner: "acme",
 *   repository: "api",
 *   name: "FORGEJO_TOKEN",
 *   value: token.token,
 * });
 * ```
 *
 * @resource
 */
export const ApiToken = Resource<ApiToken>("Forgejo.ApiToken");

interface ApiAccessToken {
  readonly id: number;
  readonly name: string;
  readonly sha1?: string;
  readonly token_last_eight: string;
  readonly created_at: string;
}

const tokensPath = (username: string) =>
  `/admin/users/${encodeURIComponent(username)}/tokens`;

const tokenPath = (username: string, tokenId: number) =>
  `${tokensPath(username)}/${encodeURIComponent(String(tokenId))}`;

const listTokens = Effect.fn(function* (username: string) {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ApiAccessToken>(client, tokensPath(username));
});

/**
 * Raised when Forgejo accepts a token creation but omits the generated
 * secret, which can never be recovered from a later read.
 */
export class MissingGeneratedToken extends Error {
  constructor() {
    super(
      "Forgejo did not return the generated API token in the create response.",
    );
    this.name = "MissingGeneratedToken";
  }
}

/**
 * Provider layer implementing the Forgejo API-token lifecycle.
 */
export const ApiTokenProvider = () =>
  Provider.succeed(ApiToken, {
    stables: ["tokenId", "token"],
    diff: ({ news, olds }) => {
      if (!isResolved(news) || olds === undefined) return Effect.void;
      return Effect.succeed(
        news.username !== olds.username ||
          news.name !== olds.name ||
          JSON.stringify(news.scopes ?? []) !==
            JSON.stringify(olds.scopes ?? []) ||
          JSON.stringify(news.repositories ?? []) !==
            JSON.stringify(olds.repositories ?? [])
          ? { action: "replace" as const, deleteFirst: true }
          : undefined,
      );
    },
    // Tokens are enumerable only per user, and the set of users is not
    // derivable from the credential, so account-wide enumeration is not
    // offered rather than partially claimed.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return undefined;
      const tokens = yield* listTokens(olds.username);
      return tokens.some((token) => token.id === output.tokenId)
        ? output
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe: a token we already generated is unchanged and its plaintext
      // is unrecoverable, so an existing one is kept as-is.
      if (output !== undefined) {
        const tokens = yield* listTokens(news.username);
        if (tokens.some((token) => token.id === output.tokenId)) return output;
      }

      const client = yield* ForgejoCredentials;
      const created = yield* client.request<ApiAccessToken>(
        "POST",
        tokensPath(news.username),
        {
          body: {
            name: news.name,
            scopes: news.scopes === undefined ? undefined : [...news.scopes],
            repositories:
              news.repositories === undefined
                ? undefined
                : news.repositories.map(({ owner, name }) => ({ owner, name })),
          },
        },
      );
      if (created.sha1 === undefined) {
        return yield* Effect.fail(new MissingGeneratedToken());
      }
      return {
        tokenId: created.id,
        token: Redacted.make(created.sha1),
        tokenLastEight: created.token_last_eight,
        createdAt: created.created_at,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const client = yield* ForgejoCredentials;
      yield* optional(
        client.request<void>(
          "DELETE",
          tokenPath(olds.username, output.tokenId),
        ),
      );
    }),
  });
