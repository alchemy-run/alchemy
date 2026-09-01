import * as Data from "effect/Data";
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

/** Order-insensitive comparison of two optional string lists. */
const sameSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
};

const tokensPath = (username: string) =>
  `/admin/users/${encodeURIComponent(username)}/tokens`;

const tokenPath = (username: string, tokenId: number) =>
  `${tokensPath(username)}/${encodeURIComponent(String(tokenId))}`;

const listTokens = Effect.fn(function* (username: string) {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ApiAccessToken>(client, tokensPath(username));
});

/**
 * Raised when a token of this name already exists but no state row does.
 *
 * Forgejo returns a token's secret exactly once, at creation, so a token
 * whose state row was lost cannot be adopted — the secret is unrecoverable,
 * and Forgejo refuses a second token of the same name. Creating blindly would
 * fail on every subsequent deploy with a duplicate-name rejection that says
 * nothing about how to recover, so the situation is named instead: it needs
 * an operator to decide whether the live token is still in use.
 */
export class UnrecoverableApiToken extends Data.TaggedError(
  "UnrecoverableApiToken",
)<{
  /**
   * User the token belongs to.
   */
  readonly username: string;
  /**
   * Name of the token that already exists.
   */
  readonly name: string;
  /**
   * Numeric ID of the existing token.
   */
  readonly tokenId: number;
}> {
  /**
   * Human-readable description of the unrecoverable token, naming the way out.
   */
  override get message(): string {
    return `Forgejo already has an API token named '${this.name}' for user '${this.username}' (id ${this.tokenId}), but no state records it. Its secret was only returned when it was created and cannot be read back. Delete that token if it is no longer in use and deploy again, or give this resource a different name.`;
  }
}

/**
 * Raised when Forgejo accepts a token creation but omits the generated
 * secret, which can never be recovered from a later read.
 */
export class MissingGeneratedToken extends Data.TaggedError(
  "MissingGeneratedToken",
)<{
  /**
   * User the token was generated for.
   */
  readonly username: string;
  /**
   * Name of the token Forgejo was asked to create.
   */
  readonly name: string;
}> {
  /**
   * Human-readable description of the unusable create response.
   */
  override get message(): string {
    return `Forgejo did not return the generated API token '${this.name}' for user '${this.username}' in the create response.`;
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
      // Replacing a token deletes the old one before minting the new one
      // (Forgejo rejects a duplicate token name), so every consumer of the
      // old value breaks in between. The trigger must therefore fire on a
      // genuine change only, never on a cosmetic reorder.
      const sameScopes = sameSet(news.scopes, olds.scopes);
      const sameRepositories = sameSet(
        news.repositories?.map(
          (repository) => `${repository.owner}/${repository.name}`,
        ),
        olds.repositories?.map(
          (repository) => `${repository.owner}/${repository.name}`,
        ),
      );
      return Effect.succeed(
        news.username !== olds.username ||
          news.name !== olds.name ||
          !sameScopes ||
          !sameRepositories
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
      const tokens = yield* listTokens(news.username);
      if (
        output !== undefined &&
        tokens.some((token) => token.id === output.tokenId)
      ) {
        return output;
      }

      // Without a state row, a token already holding this name is not ours to
      // replace and not possible to adopt — its secret is gone. Creating here
      // would be rejected for the duplicate name on this deploy and every one
      // after it, so say what actually happened instead.
      const conflict = tokens.find((token) => token.name === news.name);
      if (conflict !== undefined) {
        return yield* new UnrecoverableApiToken({
          username: news.username,
          name: news.name,
          tokenId: conflict.id,
        });
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
        return yield* new MissingGeneratedToken({
          username: news.username,
          name: news.name,
        });
      }
      return {
        tokenId: created.id,
        token: Redacted.make(created.sha1),
        tokenLastEight: created.token_last_eight,
        createdAt: created.created_at,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return;
      const client = yield* ForgejoCredentials;
      yield* optional(
        client.request<void>(
          "DELETE",
          tokenPath(olds.username, output.tokenId),
        ),
      );
    }),
  });
