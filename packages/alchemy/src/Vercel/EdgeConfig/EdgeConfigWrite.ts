import {
  DEFAULT_API_BASE_URL,
  Credentials,
} from "@distilled.cloud/vercel/Credentials";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { EdgeConfig } from "./EdgeConfig.ts";

/**
 * A management-plane write against the Edge Config failed. Writes go to
 * `PATCH /v1/global-config/{edgeConfigId}/items` on `https://api.vercel.com`
 * via the distilled `global_config` service; distilled's typed errors are
 * re-wrapped into this public error at the client boundary and ride `cause`.
 */
export class EdgeConfigWriteError extends Data.TaggedError(
  "Vercel.EdgeConfigWriteError",
)<{
  readonly message: string;
  /** The operation that failed (`set` | `delete` | `patch` | `connect`). */
  readonly operation: string;
  /** HTTP status of the failing response, when one was received. */
  readonly status?: number | undefined;
  readonly cause?: unknown;
}> {}

/** One batched item mutation (mirrors the management API's PATCH body). */
export interface EdgeConfigWriteOperation {
  readonly operation: "upsert" | "delete";
  readonly key: string;
  /** Required for `upsert`; ignored for `delete`. Any JSON value. */
  readonly value?: unknown;
}

/**
 * Typed write client for an {@link EdgeConfig}, returned by the
 * {@link EdgeConfigWrite} binding. Every method requires
 * {@link RuntimeContext}: writes resolve the management token bound into
 * the deployed Function's environment.
 *
 * Writes ride the Vercel **management API** (there is no write data plane),
 * so they are strongly consistent at the API but propagate to the read data
 * plane (`edge-config.vercel.com`) with the usual sub-second replication
 * delay.
 */
export interface WriteEdgeConfigClient {
  /** Upsert every key in the record (one batched PATCH). */
  set(
    items: Record<string, unknown>,
  ): Effect.Effect<void, EdgeConfigWriteError, RuntimeContext>;
  /** Delete the given keys (one batched PATCH; missing keys are an API error). */
  delete(
    keys: readonly string[],
  ): Effect.Effect<void, EdgeConfigWriteError, RuntimeContext>;
  /** Raw batched mutation — mix upserts and deletes in one PATCH. */
  patch(
    operations: readonly EdgeConfigWriteOperation[],
  ): Effect.Effect<void, EdgeConfigWriteError, RuntimeContext>;
}

/**
 * Bind an {@link EdgeConfig} to a Function with write access and obtain the
 * typed management-plane client (`set`, `delete`, `patch`).
 *
 * ## Runtime authorization (explicit opt-in — read before using)
 *
 * Edge Config **writes have no scoped credential**. This is a live-verified
 * platform limitation (probe 2026-08): `POST /v3/user/tokens` can mint
 * `scope: "project-only"` tokens (with expiry), but Edge Configs are owned
 * by the **team**, not a project — a project-scoped token's
 * `getEdgeConfig`/`patchEdgeConfigItems` answer `NotFound` and
 * `createEdgeConfigToken` answers `Forbidden`. The only token that can
 * write Edge Config items is a **team-wide (or user-wide) API token** —
 * full management authority over every project and resource in the team.
 *
 * Alchemy therefore **never auto-binds its own management token** into a
 * Function. The {@link WriteEdgeConfigHttp} implementation layer requires
 * YOU to hand it a token explicitly (`Config.redacted(...)` or a
 * `Redacted` value), and by accepting that you accept the tradeoff: any
 * code (or dependency) running in that Function can use the bound token
 * for ANY team-scoped management call, not just Edge Config writes. Prefer
 * a dedicated machine-user token with an `expiresAt`, rotate it, and reach
 * for deploy-time declarative `items` on the {@link EdgeConfig} resource
 * whenever runtime writes are not strictly required.
 *
 * @binding
 * @section Writing an Edge Config at runtime
 * @example Explicit opt-in with a user-supplied token
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Admin extends Vercel.Function<Admin>()(
 *   "Admin",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const flags = yield* Vercel.EdgeConfig("Flags", {});
 *     const writer = yield* Vercel.WriteEdgeConfig(flags);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* writer.set({ maintenance: true }).pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }).pipe(
 *     // The token is YOUR team-wide management token — resolved from the
 *     // deploy environment and synced as a sensitive project env var.
 *     Effect.provide(
 *       Vercel.WriteEdgeConfigHttp({
 *         token: Config.redacted("EDGE_CONFIG_WRITE_TOKEN"),
 *       }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @example Batched upserts and deletes
 * ```typescript
 * yield* writer.patch([
 *   { operation: "upsert", key: "banner", value: "hello" },
 *   { operation: "delete", key: "legacyFlag" },
 * ]);
 * ```
 */
export interface EdgeConfigWrite extends Binding.Service<
  EdgeConfigWrite,
  "Vercel.EdgeConfigWrite",
  (config: EdgeConfig) => Effect.Effect<WriteEdgeConfigClient>
> {}

export const EdgeConfigWrite = Binding.Service<EdgeConfigWrite>(
  "Vercel.EdgeConfigWrite",
);

/**
 * Ergonomic alias for {@link EdgeConfigWrite} —
 * `yield* Vercel.WriteEdgeConfig(flags)`.
 */
export const WriteEdgeConfig = EdgeConfigWrite;

// ─────────────────────────────────────────────────────────────────────────────
// Effect client
// ─────────────────────────────────────────────────────────────────────────────

/** What a write needs: the config's identity plus the management token. */
export interface EdgeConfigWriteTarget {
  readonly edgeConfigId: string;
  /** Team the config belongs to; omit for personal-scope configs. */
  readonly teamId?: string | undefined;
  /** Team-wide management token (see the security note on {@link EdgeConfigWrite}). */
  readonly token: Redacted.Redacted<string>;
  /**
   * Management API base URL. Defaults to the `VERCEL_API_URL` env override
   * when set, else `https://api.vercel.com`.
   */
  readonly apiBaseUrl?: string | undefined;
}

type PatchError = globalConfig.PatchEdgeConfigItemsError;

/** HTTP statuses of the typed distilled error tags (parallel to reads). */
const WRITE_ERROR_STATUS: { readonly [tag: string]: number | undefined } = {
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
};

const statusOf = (cause: PatchError): number | undefined =>
  cause._tag === "HttpClientError"
    ? cause.response?.status
    : WRITE_ERROR_STATUS[cause._tag];

const wrapWriteError =
  (operation: string) =>
  (cause: PatchError): EdgeConfigWriteError =>
    new EdgeConfigWriteError({
      message: `Edge Config ${operation} failed: ${cause.message}`,
      operation,
      status: statusOf(cause),
      cause,
    });

/**
 * Build a {@link WriteEdgeConfigClient} from a resolved target (or an
 * accessor Effect — the {@link WriteEdgeConfigHttp} binding passes the
 * env-reading accessor). The `HttpClient` is captured once at construction;
 * every write goes through the distilled `global_config.patchEdgeConfigItems`
 * operation with per-target credentials.
 */
export const makeWriteEdgeConfigClient = (
  target:
    | EdgeConfigWriteTarget
    | Effect.Effect<EdgeConfigWriteTarget, EdgeConfigWriteError>,
): Effect.Effect<WriteEdgeConfigClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();

    const resolveTarget: Effect.Effect<
      EdgeConfigWriteTarget,
      EdgeConfigWriteError
    > = Effect.isEffect(target) ? target : Effect.succeed(target);

    const applyPatch = (
      operation: string,
      operations: readonly EdgeConfigWriteOperation[],
    ): Effect.Effect<void, EdgeConfigWriteError> =>
      operations.length === 0
        ? Effect.void
        : resolveTarget.pipe(
            Effect.flatMap((resolved) =>
              globalConfig
                .patchEdgeConfigItems({
                  edgeConfigId: resolved.edgeConfigId,
                  teamId: resolved.teamId,
                  items: operations.map((op) =>
                    op.operation === "upsert"
                      ? {
                          operation: "upsert" as const,
                          key: op.key,
                          value: op.value,
                        }
                      : { operation: "delete" as const, key: op.key },
                  ),
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(wrapWriteError(operation)),
                  Effect.provideService(
                    Credentials,
                    Effect.succeed({
                      token: resolved.token,
                      apiBaseUrl:
                        resolved.apiBaseUrl ??
                        process.env.VERCEL_API_URL ??
                        DEFAULT_API_BASE_URL,
                    }),
                  ),
                ),
            ),
            Effect.provideContext(context),
          );

    return {
      set: (items) =>
        applyPatch(
          "set",
          Object.entries(items).map(([key, value]) => ({
            operation: "upsert" as const,
            key,
            value,
          })),
        ),
      delete: (keys) =>
        applyPatch(
          "delete",
          keys.map((key) => ({ operation: "delete" as const, key })),
        ),
      patch: (operations) => applyPatch("patch", operations),
    } satisfies WriteEdgeConfigClient;
  });
