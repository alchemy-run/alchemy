/**
 * The `tokens` group: per-repo token management (DESIGN.md §5, §8).
 *
 * Requires the repo `admin` scope (or the admin key); enforced in the
 * Repo DO.
 */
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  CreatedToken,
  Forbidden,
  GitAuth,
  OwnerName,
  RepoName,
  RepoNotFound,
  RepoPath,
  TokenInfo,
  TokenNotFound,
  TokenScope,
} from "./Schema.ts";

/** Mints a token; the plaintext value is shown exactly once. */
export const create = HttpApiEndpoint.post(
  "create",
  "/repos/:owner/:repo/tokens",
  {
    params: RepoPath,
    payload: Schema.Struct({
      /** Human-readable label. */
      name: Schema.String,
      scope: TokenScope,
      /** Optional TTL in seconds; absent = no expiry. */
      ttlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
    success: CreatedToken,
    error: [RepoNotFound, Forbidden],
  },
);

/** Lists token metadata (values are never returned). */
export const list = HttpApiEndpoint.get("list", "/repos/:owner/:repo/tokens", {
  params: RepoPath,
  success: Schema.Array(TokenInfo),
  error: [RepoNotFound, Forbidden],
});

/** Revokes a token by id. */
export const revoke = HttpApiEndpoint.delete(
  "revoke",
  "/repos/:owner/:repo/tokens/:id",
  {
    params: Schema.Struct({
      owner: OwnerName,
      repo: RepoName,
      id: Schema.String,
    }),
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, TokenNotFound, Forbidden],
  },
);

/** The assembled `tokens` group. */
export const Group = HttpApiGroup.make("tokens")
  .add(create)
  .add(list)
  .add(revoke)
  .middleware(GitAuth);
