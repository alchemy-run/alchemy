/**
 * A Cloudflare R2 API token — scoped S3-compatible credentials minted
 * via `POST /accounts/{account_id}/r2/tokens`.
 *
 * R2 tokens are separate from the standard Cloudflare API tokens.
 * They carry an `accessKeyId` / `secretAccessKey` pair that SigV4
 * presigners (`aws4fetch`, AWS SDK) consume directly. The
 * `secret_access_key` is returned exactly once on creation and is
 * never re-exposed by the API — Alchemy persists it via the State
 * service so the resource is reproducible from state alone.
 *
 * Cloudflare does not expose a token-delete API; the `delete`
 * operation is a no-op that emits a warning so the deploy logs are
 * explicit. Tokens persist until manually revoked in the Cloudflare
 * dashboard (R2 → Manage R2 API Tokens).
 *
 * @example Mint and bind a presign token to a Worker
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * const Media = Cloudflare.R2.Bucket("Media");
 *
 * const PresignToken = Cloudflare.R2.Token("presign", {
 *   bucketNames: [Media.bucketName],
 * });
 *
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Cloudflare.providers() },
 *   Effect.gen(function* () {
 *     const api = yield* Cloudflare.Worker("Api", {
 *       main: "./worker.ts",
 *       bindings: { MEDIA: Media },
 *     }).pipe(Alchemy.provide(Cloudflare.R2.PresignedUrlBinding));
 *     return { url: api.url, tokenId: PresignToken.tokenId };
 *   }),
 * );
 * ```
 *
 * @section Adoption and reconciliation
 * On `read`, the provider looks up tokens by name (the API returns id +
 * name but not the secret). If a token with the same name already
 * exists, the existing one is adopted (no new token is minted); the
 * `secret_access_key` from the most recent mint is loaded from
 * Alchemy state.
 *
 * @see https://developers.cloudflare.com/r2/api/s3/api-tokens/
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { createR2Token, listR2Tokens } from "./R2TokenClient.ts";

const TypeId = "Cloudflare.R2.Token" as const;
type TypeId = typeof TypeId;

export interface R2TokenProps {
  /**
   * Bucket names this token is scoped to. Defaults to `["*"]` (all
   * buckets in the account) — the closest analogue to the
   * dashboard's "Object Read & Write" template.
   */
  bucketNames?: ReadonlyArray<string>;
}

export interface R2TokenAttributes {
  /**
   * Cloudflare's id for the token (stable across reads).
   */
  tokenId: string;
  /**
   * The auto-generated or user-provided name used to look up the
   * token on subsequent deploys.
   */
  name: string;
  /**
   * R2 access key id (use as `AccessKeyId` in SigV4 signing).
   */
  accessKeyId: string;
  /**
   * R2 secret access key (use as `SecretAccessKey` in SigV4 signing).
   * Persisted from the original mint; never re-fetchable.
   */
  secretAccessKey: Redacted.Redacted<string>;
  /**
   * Account id the token belongs to.
   */
  accountId: string;
  /**
   * Bucket names the token is scoped to.
   */
  bucketNames: ReadonlyArray<string>;
}

export type R2Token = Resource<
  "Cloudflare.R2.Token",
  R2TokenProps,
  R2TokenAttributes,
  never,
  Providers
>;

export const R2Token = Resource<R2Token>(TypeId);

export const R2TokenProvider = () =>
  Provider.succeed(R2Token, {
    stables: ["tokenId", "accountId"],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // A token's scope (bucketNames) is immutable after creation —
      // changing it replaces the resource.
      if (!output) return undefined;
      const oldBuckets = output.bucketNames.join(",");
      const newBuckets = (news.bucketNames ?? output.bucketNames).join(",");
      if (oldBuckets !== newBuckets) {
        return { action: "replace" } as const;
      }
      // Rename is also a replacement.
      const oldName = output.name;
      const newName = (news as { name?: string }).name ?? oldName;
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = output?.name ?? (yield* createPhysicalName({ id }));
      const existing = (yield* listR2Tokens()).find((t) => t.name === name);
      if (!existing) return undefined;
      return {
        tokenId: existing.id,
        name: existing.name,
        // We can't recover the secret from a read — fall back to whatever
        // we have in state (will be `Redacted.make("")` for never-minted).
        accessKeyId: output?.accessKeyId ?? "",
        secretAccessKey: output?.secretAccessKey ?? Redacted.make(""),
        accountId,
        bucketNames: output?.bucketNames ?? [],
      } satisfies R2TokenAttributes;
    }),

    list: Effect.fn(function* () {
      const tokens = yield* listR2Tokens();
      return tokens.map((t) => ({
        tokenId: t.id,
        name: t.name,
        accessKeyId: "",
        secretAccessKey: Redacted.make(""),
        accountId: "",
        bucketNames: [],
      }));
    }),

    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name =
        (news as { name?: string }).name ??
        output?.name ??
        (yield* createPhysicalName({ id }));
      const bucketNames = news.bucketNames ?? output?.bucketNames ?? ["*"];

      // Try to reuse an existing token with the same name.
      const existing = (yield* listR2Tokens()).find((t) => t.name === name);
      if (existing && output?.secretAccessKey) {
        return {
          tokenId: existing.id,
          name: existing.name,
          accessKeyId: output.accessKeyId,
          secretAccessKey: output.secretAccessKey,
          accountId,
          bucketNames,
        } satisfies R2TokenAttributes;
      }

      const minted = yield* createR2Token({ name, bucketNames });
      yield* Effect.logWarning(
        `Minted R2 API token "${minted.name}" (id ${minted.id}). ` +
          `Cloudflare does not expose a delete API — revoke it manually in R2 → Manage R2 API Tokens when no longer needed.`,
      );
      return {
        tokenId: minted.id,
        name: minted.name,
        accessKeyId: minted.accessKeyId,
        secretAccessKey: Redacted.make(minted.secretAccessKey),
        accountId,
        bucketNames,
      } satisfies R2TokenAttributes;
    }),

    // R2 has no token-delete API; deletion is a no-op with a warning so
    // the deploy logs are explicit about the leak.
    delete: Effect.fn(function* () {
      yield* Effect.logWarning(
        "Cloudflare.R2.Token has no remote delete API. The token remains valid in Cloudflare until manually revoked.",
      );
    }),
  });
