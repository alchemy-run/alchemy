import * as globalConfig from "@distilled.cloud/vercel/global_config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

export interface EdgeConfigTokenProps {
  /**
   * ID of the Edge Config the token grants read access to (e.g. `ecfg_…`).
   * Changing it replaces the token.
   */
  edgeConfigId: string;
  /**
   * Human-readable label for the token (shown in the Vercel dashboard).
   * If omitted, a unique label is generated from the app, stage, and
   * logical ID. Tokens are immutable on Vercel, so changing the label
   * mints a fresh token (and deletes the old one).
   */
  label?: string;
}

export interface EdgeConfigToken extends Resource<
  "Vercel.EdgeConfigToken",
  EdgeConfigTokenProps,
  {
    /**
     * ID of the token — used to reference (e.g. delete) the token; NOT the
     * secret itself.
     */
    tokenId: string;
    /**
     * ID of the Edge Config the token reads.
     */
    edgeConfigId: string;
    /**
     * The token's label.
     */
    label: string;
    /**
     * Creation timestamp (ms since epoch).
     */
    createdAt: number;
    /**
     * The plaintext token value. Vercel returns this only once, on
     * creation, so it is persisted here (observe-and-keep — the token is
     * never re-minted while it still exists on Vercel).
     */
    token: Redacted.Redacted<string>;
    /**
     * The Edge Config connection string
     * (`https://edge-config.vercel.com/{edgeConfigId}?token={token}`) —
     * the exact shape `@vercel/edge-config` and
     * {@link readEdgeConfigFromEnv} accept.
     */
    connectionString: Redacted.Redacted<string>;
  },
  never,
  Providers
> {}

type EdgeConfigTokenAttributes = EdgeConfigToken["Attributes"];

/**
 * A read token for a Vercel Edge Config — grants data-plane read access
 * (`https://edge-config.vercel.com/{edgeConfigId}`) scoped to a single
 * Edge Config.
 *
 * Vercel discloses the plaintext token exactly once, at creation, so the
 * provider persists it in state and *observes-and-keeps*: as long as the
 * token still exists on Vercel, subsequent deploys reuse the same value
 * (no churn in dependent env vars). The {@link ReadEdgeConfigHttp} binding
 * mints one of these per Function automatically — declare it explicitly
 * only for async-mode Functions or external consumers.
 * @resource
 * @section Creating a Read Token
 * @example Token for an Edge Config
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 *
 * const flags = yield* Vercel.EdgeConfig("flags", {
 *   items: { enableCheckout: true },
 * });
 * const token = yield* Vercel.EdgeConfigToken("flags-token", {
 *   edgeConfigId: flags.edgeConfigId,
 * });
 * ```
 *
 * @section Async Functions
 * @example Bind the connection string into an async Function's env
 * ```typescript
 * const fn = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   env: {
 *     // Redacted ⇒ synced as a `sensitive` project env var
 *     FLAGS: token.connectionString,
 *   },
 * });
 *
 * // src/api.ts
 * import { readEdgeConfigFromEnv } from "alchemy/Vercel";
 * const flags = readEdgeConfigFromEnv("FLAGS");
 * const enabled = await flags.get("enableCheckout");
 * ```
 *
 * @see https://vercel.com/docs/edge-config/vercel-api#tokens
 */
export const EdgeConfigToken = Resource<EdgeConfigToken>(
  "Vercel.EdgeConfigToken",
);

/** The data-plane connection string for an Edge Config + read token. */
export const edgeConfigConnectionString = (
  edgeConfigId: string,
  token: string,
): string => `https://edge-config.vercel.com/${edgeConfigId}?token=${token}`;

const createLabel = (id: string, label: string | undefined) =>
  Effect.gen(function* () {
    // Token labels are display-only; keep them comfortably short.
    return label ?? (yield* createPhysicalName({ id, maxLength: 52 }));
  });

const toTokenAttributes = (
  meta: {
    id: string;
    edgeConfigId: string;
    label: string;
    createdAt: number;
  },
  token: Redacted.Redacted<string>,
): EdgeConfigTokenAttributes => ({
  tokenId: meta.id,
  edgeConfigId: meta.edgeConfigId,
  label: meta.label,
  createdAt: meta.createdAt,
  token,
  connectionString: Redacted.make(
    edgeConfigConnectionString(meta.edgeConfigId, Redacted.value(token)),
  ),
});

/**
 * Observe the token by its persisted plaintext (the detail endpoint
 * addresses tokens by value — the list endpoint never returns plaintext, so
 * the persisted secret is the only usable lookup key).
 */
const observeToken = (
  edgeConfigId: string,
  token: Redacted.Redacted<string>,
  teamId: string | undefined,
) =>
  globalConfig
    .getEdgeConfigToken({
      edgeConfigId,
      token: Redacted.value(token),
      teamId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const mintToken = Effect.fn(function* ({
  edgeConfigId,
  label,
  teamId,
  session,
}: {
  edgeConfigId: string;
  label: string;
  teamId: string | undefined;
  session: ScopedPlanStatusSession;
}) {
  const created = yield* globalConfig.createEdgeConfigToken({
    edgeConfigId,
    label,
    teamId,
  });
  yield* session.note(`Created Edge Config token: ${label}`);
  // The create response carries only { id, token } — read the full
  // metadata (createdAt) back through the detail endpoint.
  const meta = yield* globalConfig.getEdgeConfigToken({
    edgeConfigId,
    token: created.token,
    teamId,
  });
  return toTokenAttributes(meta, Redacted.make(created.token));
});

export const EdgeConfigTokenProvider = () =>
  Provider.succeed(EdgeConfigToken, {
    stables: ["edgeConfigId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Moving the token to another Edge Config is a replacement (the new
      // parent must exist before the old token dies); label changes are
      // in-place updates (reconcile mints a successor + deletes the old).
      const oldEdgeConfigId = output?.edgeConfigId ?? olds?.edgeConfigId;
      if (
        oldEdgeConfigId !== undefined &&
        news.edgeConfigId !== oldEdgeConfigId
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      // Cold read is impossible: the plaintext (the only lookup key that
      // returns full metadata) lives solely in our state.
      if (output?.token === undefined) return undefined;
      const { teamId } = yield* VercelEnvironment.current;
      const observed = yield* observeToken(
        output.edgeConfigId,
        output.token,
        teamId,
      );
      if (observed === undefined) return undefined;
      return toTokenAttributes(observed, output.token);
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
      const { teamId } = yield* VercelEnvironment.current;
      const edgeConfigId = news.edgeConfigId ?? output?.edgeConfigId;
      if (edgeConfigId === undefined) {
        return yield* Effect.die(
          `Vercel.EdgeConfigToken(${id}): \`edgeConfigId\` is required`,
        );
      }
      const label = yield* createLabel(id, news.label);

      // 1. Observe — the persisted plaintext is a hint, not a guarantee.
      const observed =
        output?.token !== undefined && output.edgeConfigId === edgeConfigId
          ? yield* observeToken(edgeConfigId, output.token, teamId)
          : undefined;

      // 2. Converged: same token, same label — keep it (never re-mint; a
      //    rotation would invalidate the value baked into every dependent
      //    env row and older deployment).
      if (observed !== undefined && observed.label === label) {
        return toTokenAttributes(observed, output!.token);
      }

      // 3. Label drift: tokens are immutable — mint the successor first,
      //    then retire the old token.
      const attributes = yield* mintToken({
        edgeConfigId,
        label,
        teamId,
        session,
      });
      if (observed !== undefined) {
        yield* globalConfig
          .deleteEdgeConfigTokens({
            edgeConfigId,
            ids: [observed.id],
            teamId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* session.note(
          `Replaced Edge Config token: ${observed.label} -> ${label}`,
        );
      }
      return attributes;
    }),
    delete: Effect.fn(function* ({ output, session }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Idempotent: a token already gone — or a parent Edge Config already
      // deleted (which cascades its tokens) — reports NotFound.
      yield* globalConfig
        .deleteEdgeConfigTokens({
          edgeConfigId: output.edgeConfigId,
          ids: [output.tokenId],
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* session.note(`Deleted Edge Config token: ${output.label}`);
    }),
  });
