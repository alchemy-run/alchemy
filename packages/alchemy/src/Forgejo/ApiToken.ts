import { Services } from "@distilled.cloud/forgejo";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { Credentials } from "./Credentials.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { toRedacted } from "./Redacted.ts";
import { paginate } from "./Pagination.ts";
import type * as Forgejo from "./Providers.ts";
import { sameSet } from "./Settings.ts";

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
   * User that owns the generated token. Omit to discover the authenticated
   * deployment user. Automatic provisioning requires an administrator profile.
   */
  readonly username?: string;
  /**
   * Human-readable token name. Omit for a generation-specific physical name
   * supporting create-first replacement. Explicit same-name rotation is delete-first.
   */
  readonly name?: string;
  /**
   * Nonempty permission scopes granted to the token. No broad default is applied.
   */
  readonly scopes: readonly string[];
  /**
   * Repositories the token may access. Omit for unrestricted repository
   * access. An explicit empty list is invalid. Restricted tokens only allow
   * read/write repository and issue scopes.
   */
  readonly repositories?: readonly ApiTokenRepository[];
  /** Change this value to replace the credential without changing its permissions. */
  readonly rotation?: string;
}

/**
 * Observed attributes of a Forgejo API token.
 */
export interface ApiTokenAttributes {
  /** User that owns the token. */
  readonly username: string;
  /** Physical token name, including its generation when generated. */
  readonly name: string;
  /** Hosting Forgejo API v1 endpoint. */
  readonly apiBaseUrl: string;
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
 *   scopes: ["read:repository"],
 * });
 * ```
 *
 * **Example:** Scoped, Repository-Restricted Token
 * ```typescript
 * yield* Forgejo.ApiToken("deploy", {
 *   username: "ci-bot",
 *   name: "deploy",
 *   scopes: ["write:repository", "read:issue"],
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
 *   scopes: ["read:repository"],
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

/**
 * Flatten repository restrictions into comparable `owner/name` slugs.
 */
const repositorySlugs = (
  repositories: readonly ApiTokenRepository[] | undefined,
): readonly string[] | undefined =>
  repositories?.map((repository) => `${repository.owner}/${repository.name}`);

/** The deployment profile cannot provision restricted runtime credentials. */
export class ForgejoTokenBootstrapDenied extends Data.TaggedError(
  "ForgejoTokenBootstrapDenied",
)<{ readonly message: string }> {}

const bootstrapDenied = () =>
  Effect.fail(
    new ForgejoTokenBootstrapDenied({
      message:
        "Automatic Forgejo token provisioning requires an administrator deployment profile with write:admin and read:user scopes. Update the Forgejo profile credential; the deployment token is never forwarded to runtime.",
    }),
  );

const listTokens = (username: string) =>
  paginate(Services.admin.adminListUserAccessTokens, { username }).pipe(
    Effect.catchTag("Forbidden", bootstrapDenied),
  );

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

export class InvalidApiToken extends Data.TaggedError("InvalidApiToken")<{
  readonly message: string;
}> {}

const validate = (props: Pick<ApiTokenProps, "scopes" | "repositories">) => {
  const message =
    !props.scopes?.length || props.scopes.some((scope) => !scope.trim())
      ? "API tokens require a nonempty explicit scopes list."
      : props.repositories?.length === 0
        ? "repositories: [] is invalid; omit repositories for unrestricted access."
        : props.repositories !== undefined &&
            props.scopes.some(
              (scope) =>
                ![
                  "read:repository",
                  "write:repository",
                  "read:issue",
                  "write:issue",
                ].includes(scope),
            )
          ? "Repository-restricted tokens only support read/write repository and issue scopes."
          : undefined;
  return message === undefined
    ? Effect.void
    : Effect.fail(new InvalidApiToken({ message }));
};

/**
 * Provider layer implementing the Forgejo API-token lifecycle.
 */
export const ApiTokenProvider = () =>
  Provider.succeed(ApiToken, {
    stables: ["tokenId", "token"],
    diff: Effect.fn(function* ({ news, olds }) {
      // Unresolved restrictions may change permissions. Validate a successor
      // before revoking the predecessor rather than treating this as an update.
      if (!isResolved(news))
        return olds === undefined ? undefined : { action: "replace" as const };
      yield* validate(news);
      if (olds === undefined) return;
      if (
        news.username !== olds.username ||
        news.name !== olds.name ||
        news.rotation !== olds.rotation ||
        !sameSet(news.scopes, olds.scopes) ||
        (news.repositories === undefined) !==
          (olds.repositories === undefined) ||
        !sameSet(
          repositorySlugs(news.repositories),
          repositorySlugs(olds.repositories),
        )
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            news.name !== undefined &&
            news.name === olds.name &&
            news.username === olds.username,
        };
      }
    }),
    // Tokens are enumerable only per user, and the set of users is not
    // derivable from the credential, so account-wide enumeration is not
    // offered rather than partially claimed.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return undefined;
      const tokens = yield* listTokens(output.username ?? olds.username!);
      return tokens.some((token) => token.id === output.tokenId)
        ? output
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      yield* validate(news);
      const name =
        output?.name ??
        news.name ??
        (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }));
      const { apiBaseUrl } = yield* yield* Credentials;
      const username =
        news.username ??
        (yield* Effect.gen(function* () {
          const user = yield* Services.user
            .userGetCurrent({})
            .pipe(Effect.catchTag("Forbidden", bootstrapDenied));
          if (!user.is_admin) return yield* bootstrapDenied();
          return user.login;
        }));
      const tokens = yield* listTokens(username);
      if (
        output !== undefined &&
        tokens.some((token) => token.id === output.tokenId)
      ) {
        return { ...output, name, username, apiBaseUrl };
      }

      // Without a state row, a token already holding this name is not ours to
      // replace and not possible to adopt — its secret is gone. Creating here
      // would be rejected for the duplicate name on this deploy and every one
      // after it, so say what actually happened instead.
      const conflict = tokens.find((token) => token.name === name);
      if (conflict !== undefined) {
        return yield* new UnrecoverableApiToken({
          username,
          name,
          tokenId: conflict.id,
        });
      }

      const created = yield* Services.admin
        .adminCreateUserAccessToken({
          username,
          name,
          scopes: [...news.scopes],
          repositories:
            news.repositories === undefined
              ? undefined
              : news.repositories.map(({ owner, name }) => ({ owner, name })),
        })
        .pipe(Effect.catchTag("Forbidden", bootstrapDenied));
      if (created.sha1 === undefined) {
        return yield* new MissingGeneratedToken({
          username,
          name,
        });
      }
      return {
        username,
        name,
        apiBaseUrl,
        tokenId: created.id,
        // The SDK hands the generated secret out Redacted; a plain string is
        // only ever seen from a mock that bypasses the protocol's wrapping.
        token: toRedacted(created.sha1),
        tokenLastEight: created.token_last_eight,
        createdAt: created.created_at,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* Services.admin
        .adminDeleteUserAccessToken({
          username: output.username ?? olds.username,
          token: String(output.tokenId),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
