import * as artifacts from "@distilled.cloud/cloudflare/artifacts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Repository } from "./Repository.ts";

export type RepositoryTokenProps = {
  /**
   * The repository to mint a token for: a {@link Repository} resource, or a
   * repository name (then `namespace` is required). Changing it mints a new
   * token (replacement).
   */
  repository: Repository | string;
  /**
   * Namespace of the repository. Required when `repository` is a name;
   * ignored when it is a {@link Repository}.
   */
  namespace?: string;
  /**
   * `"read"` permits clone / fetch / pull; `"write"` also permits push.
   * Changing it mints a new token (replacement).
   * @default "read"
   */
  scope?: "read" | "write";
  /**
   * Time-to-live in seconds (60–31536000). Once the token expires, the next
   * deploy mints a fresh one. Changing it mints a new token (replacement).
   * @default 86400
   */
  ttl?: number;
};

export type RepositoryToken = Resource<
  "Cloudflare.Artifacts.RepositoryToken",
  RepositoryTokenProps,
  {
    /** Token ID (use to revoke). */
    tokenId: string;
    /**
     * The git access token, `art_v…?expires=<unix_seconds>`. Use it as
     * `Authorization: Bearer <token>` or (minus the `?expires=` suffix) as
     * the HTTP Basic password — see `gitCredential`.
     */
    token: Redacted.Redacted<string>;
    /** Token scope. */
    scope: "read" | "write";
    /** ISO 8601 expiry timestamp. */
    expiresAt: string;
    /** Repository name. */
    repository: string;
    /** Artifacts namespace of the repository. */
    namespace: string;
    /** HTTPS git remote URL of the repository. */
    remote: string;
    /** Cloudflare account that owns the repository. */
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A scoped, expiring git access token for a Cloudflare Artifacts
 * {@link Repository}. Tokens authenticate git-over-HTTPS (clone / fetch /
 * pull, plus push for `write`), not the REST API.
 *
 * The plaintext is only returned when the token is minted, so it is persisted
 * (redacted) in state. A new token is minted on replacement and whenever the
 * current one has expired; the old one is revoked.
 *
 * ### Minting a token
 * **Example:** Read-only clone token for one hour
 * ```typescript
 * const repo = yield* Cloudflare.Artifacts.Repository("Docs", { namespace: "my-app" });
 * const token = yield* Cloudflare.Artifacts.RepositoryToken("DocsReadToken", {
 *   repository: repo,
 *   scope: "read",
 *   ttl: 3600,
 * });
 * ```
 *
 * **Example:** Write token by repository name
 * ```typescript
 * const token = yield* Cloudflare.Artifacts.RepositoryToken("PushToken", {
 *   namespace: "my-app",
 *   repository: "docs",
 *   scope: "write",
 * });
 * ```
 *
 * ### Using the token with git
 * **Example:** Build git credentials
 * ```typescript
 * const { url, extraHeader } = Cloudflare.Artifacts.gitCredential(remote, token);
 * // git clone <url>
 * // git -c http.extraHeader="<extraHeader>" clone <remote>
 * ```
 *
 * @resource
 * @product Artifacts
 * @category Developer Platform
 */
export const RepositoryToken = Resource<RepositoryToken>("Cloudflare.Artifacts.RepositoryToken");

type Attributes = RepositoryToken["Attributes"];

/**
 * Resolve the `{ namespace, name }` a token targets. A `Repository` prop is
 * resolved to its attributes before lifecycle ops run; during `diff` it may
 * still be unresolved, in which case this returns `undefined` fields.
 */
const repoRefOf = (props: RepositoryTokenProps | undefined) => {
  const repository = props?.repository as unknown;
  if (typeof repository === "string") {
    return { namespace: props?.namespace, name: repository };
  }
  const attrs = repository as Partial<Repository["Attributes"]> | undefined;
  return {
    namespace: typeof attrs?.namespace === "string" ? attrs.namespace : undefined,
    name: typeof attrs?.name === "string" ? attrs.name : undefined,
  };
};

const isExpired = (expiresAt: string) => Date.parse(expiresAt) <= Date.now() + 60_000;

/** The active token with `tokenId`, or `undefined` (token or repository gone). */
const findActiveToken = (accountId: string, namespace: string, name: string, tokenId: string) =>
  artifacts.listRepoTokens.items({ accountId, namespace, name, state: "active" }).pipe(
    Stream.filter((t) => t.id === tokenId),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catchTag("ArtifactsRepositoryNotFound", () => Effect.succeed(undefined)),
  );

export const RepositoryTokenProvider = () =>
  Provider.succeed(RepositoryToken, {
    stables: ["repository", "namespace", "accountId", "scope"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output && output.accountId !== accountId) return { action: "replace" } as const;
      const next = repoRefOf(news as RepositoryTokenProps);
      const prev = output
        ? { namespace: output.namespace, name: output.repository }
        : repoRefOf(olds);
      if (
        (next.name !== undefined && prev.name !== undefined && next.name !== prev.name) ||
        (next.namespace !== undefined &&
          prev.namespace !== undefined &&
          next.namespace !== prev.namespace)
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.scope ?? "read") !== (output?.scope ?? olds?.scope ?? "read") ||
        (olds && (news.ttl ?? 86400) !== (olds.ttl ?? 86400))
      ) {
        return { action: "replace" } as const;
      }
      // An expired token is re-minted in place on the next deploy.
      if (output && isExpired(output.expiresAt)) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId: envAccountId } = yield* yield* CloudflareEnvironment;
      const accountId = output?.accountId ?? envAccountId;
      const { namespace, name } = repoRefOf(news);
      if (namespace === undefined || name === undefined) {
        return yield* Effect.die(
          new Error(
            "Artifacts RepositoryToken: `namespace` is required when `repository` is a name",
          ),
        );
      }
      const scope = news.scope ?? "read";

      // Observe — the repository (for its remote) and, if we already hold
      // a token for it, whether that token is still active and unexpired.
      const repo = yield* artifacts.getRepo({ accountId, namespace, name });
      const current =
        output &&
        output.namespace === namespace &&
        output.repository === name &&
        output.scope === scope &&
        !isExpired(output.expiresAt)
          ? yield* findActiveToken(accountId, namespace, name, output.tokenId)
          : undefined;
      if (output && current) {
        return { ...output, remote: repo.remote } satisfies Attributes;
      }

      // Ensure — mint a fresh token, then revoke the one it supersedes.
      const minted = yield* artifacts.createToken({
        accountId,
        namespace,
        repo: name,
        scope,
        ttl: news.ttl,
      });
      if (output?.tokenId && output.tokenId !== minted.id) {
        yield* artifacts
          .revokeToken({ accountId, namespace: output.namespace, id: output.tokenId })
          .pipe(Effect.catchTag("ArtifactsTokenNotFound", () => Effect.void));
      }
      return {
        tokenId: minted.id,
        token: Redacted.make(minted.plaintext),
        scope: minted.scope as "read" | "write",
        expiresAt: minted.expiresAt,
        repository: name,
        namespace,
        remote: repo.remote,
        accountId,
      } satisfies Attributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* artifacts
        .revokeToken({
          accountId: output.accountId,
          namespace: output.namespace,
          id: output.tokenId,
        })
        .pipe(Effect.catchTag("ArtifactsTokenNotFound", () => Effect.void));
    }),
    read: Effect.fn(function* ({ output }) {
      // The plaintext is only available from state; without it there is
      // nothing to recover, so the token is re-minted.
      if (!output) return undefined;
      const active = yield* findActiveToken(
        output.accountId,
        output.namespace,
        output.repository,
        output.tokenId,
      );
      return active ? output : undefined;
    }),
  });
