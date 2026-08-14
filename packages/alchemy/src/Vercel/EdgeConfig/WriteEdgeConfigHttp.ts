import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import { sanitizeKey, unpackEnvValue } from "../../RuntimeContext.ts";
import { isFunction } from "../Functions/Function.ts";
import type { EdgeConfig } from "./EdgeConfig.ts";
import {
  EdgeConfigWrite,
  EdgeConfigWriteError,
  makeWriteEdgeConfigClient,
  type EdgeConfigWriteTarget,
} from "./EdgeConfigWrite.ts";

/** Env keys the deploy half binds for a written config's logical id. */
const writeEnvKey = (
  logicalId: string,
  suffix: "ID" | "OWNER" | "TOKEN",
): string => `${sanitizeKey(logicalId)}_EDGE_CONFIG_WRITE_${suffix}`;

/** Options for {@link WriteEdgeConfigHttp}. */
export interface WriteEdgeConfigHttpOptions {
  /**
   * The management token used for runtime writes — a **team-wide Vercel API
   * token** supplied BY YOU (there is no scoped write credential; see the
   * security note on {@link EdgeConfigWrite}). Pass
   * `Config.redacted("SOME_ENV")` to resolve it from the deploy
   * environment, or a `Redacted` value directly. It is synced to the
   * Function as a `sensitive` project env var.
   */
  readonly token:
    | Redacted.Redacted<string>
    | Config.Config<Redacted.Redacted<string>>;
}

/**
 * HTTP (management-plane) implementation of {@link EdgeConfigWrite} —
 * an **explicit opt-in** layer factory, deliberately not a ready-made layer.
 *
 * ## Runtime authorization
 *
 * Unlike every other Vercel capability, Edge Config writes cannot be
 * granted least-privilege (live-verified: project-scoped tokens cannot see
 * team-owned Edge Configs, and the write path only accepts team/user-wide
 * management tokens — see {@link EdgeConfigWrite}). This factory therefore
 * requires the caller to supply the token themselves and makes the
 * decision visible at the call site:
 *
 * - Deploy half (guarded by `__ALCHEMY_RUNTIME__`): resolves `options.token`
 *   (a `Config.redacted` reads the DEPLOY machine's environment) and binds
 *   three env vars on the host Function — the config's id, its owner id,
 *   and the token (Redacted ⇒ synced as a `sensitive` project env var).
 * - Runtime half: reads those env vars back and issues
 *   `PATCH /v1/global-config/{edgeConfigId}/items` via the distilled
 *   `global_config` service. The `VERCEL_API_URL` env override is honored
 *   for the management base URL.
 *
 * Dev-mode note: `alchemy dev` emulates the Edge Config READ data plane
 * only; runtime writes always target the management API, so in dev they
 * fail unless the resource is deployed live (`Alchemy.remote()`).
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.WriteEdgeConfigHttp({ token: Config.redacted("...") }))`.
 */
export const WriteEdgeConfigHttp = (
  options: WriteEdgeConfigHttpOptions,
): Layer.Layer<EdgeConfigWrite, never, HttpClient.HttpClient> =>
  Layer.effect(
    EdgeConfigWrite,
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient>();

      return Effect.fn(function* (config: EdgeConfig) {
        const logicalId = (config as { LogicalId?: string }).LogicalId;
        if (logicalId === undefined) {
          return yield* Effect.die(
            new Error(
              "Vercel.WriteEdgeConfig: target has no LogicalId — pass a Vercel.EdgeConfig handle",
            ),
          );
        }
        const idKey = writeEnvKey(logicalId, "ID");
        const ownerKey = writeEnvKey(logicalId, "OWNER");
        const tokenKey = writeEnvKey(logicalId, "TOKEN");

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          // Deploy-time only: resolve the user-supplied token (Config reads
          // the deploy environment) and bind it — with the config's
          // identity — onto the host's project env. The Redacted wrapper
          // makes the token row `sensitive`.
          const host = yield* Binding.Host;
          if (isFunction(host)) {
            const token = Effect.isEffect(options.token)
              ? yield* (
                  options.token as Effect.Effect<
                    Redacted.Redacted<string>,
                    unknown
                  >
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.die(
                      new Error(
                        `Vercel.WriteEdgeConfig(${logicalId}): could not resolve the management token from options.token: ${String(
                          cause,
                        )}`,
                      ),
                    ),
                  ),
                )
              : options.token;
            yield* host.bind`WriteEdgeConfig(${host}, ${logicalId})`({
              env: {
                [idKey]: config.edgeConfigId,
                [ownerKey]: config.ownerId,
                [tokenKey]: token,
              },
            });
          }
        }

        // Lazy env reads — the bound vars only exist at the exec phase.
        const resolveTarget: Effect.Effect<
          EdgeConfigWriteTarget,
          EdgeConfigWriteError
        > = Effect.suspend(() => {
          const edgeConfigId = unpackEnvValue<string>(process.env[idKey]);
          const owner = unpackEnvValue<string>(process.env[ownerKey]);
          const rawToken = unpackEnvValue<string | Redacted.Redacted<string>>(
            process.env[tokenKey],
          );
          const token =
            rawToken === undefined
              ? undefined
              : Redacted.isRedacted(rawToken)
                ? rawToken
                : Redacted.make(rawToken);
          if (
            edgeConfigId === undefined ||
            edgeConfigId === "" ||
            token === undefined
          ) {
            return Effect.fail(
              new EdgeConfigWriteError({
                message: `Vercel.WriteEdgeConfig(${logicalId}): env ${idKey}/${tokenKey} is not set — was the WriteEdgeConfig binding deployed with this Function?`,
                operation: "connect",
              }),
            );
          }
          return Effect.succeed({
            edgeConfigId,
            // Personal-scope configs carry a user owner id; the management
            // API only takes `teamId` for team-owned configs.
            teamId:
              owner !== undefined && owner.startsWith("team_")
                ? owner
                : undefined,
            token,
          });
        });

        return yield* makeWriteEdgeConfigClient(resolveTarget).pipe(
          Effect.provideContext(context),
        );
      });
    }),
  );
