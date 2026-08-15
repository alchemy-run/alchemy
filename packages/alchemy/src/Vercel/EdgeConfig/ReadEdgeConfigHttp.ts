import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { Self } from "../../Self.ts";
import { EdgeConfigRead, makeReadEdgeConfigClient } from "./EdgeConfigRead.ts";
import { EdgeConfigToken } from "./EdgeConfigToken.ts";
import type { EdgeConfig } from "./EdgeConfig.ts";

/**
 * HTTP (data-plane) implementation of {@link EdgeConfigRead}.
 *
 * Deploy half: yields a scoped {@link EdgeConfigToken} for the bound Edge
 * Config (one per host Function + config, observe-and-keep — the token is
 * minted once and reused across deploys, so env fingerprints stay stable)
 * and captures its `connectionString` into the Function's environment as a
 * `sensitive` project env var. Runtime half: the same capture resolves the
 * connection string back out of `process.env` and the client reads via
 * `https://edge-config.vercel.com/{edgeConfigId}` with bearer auth.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.ReadEdgeConfigHttp)`.
 *
 * ## Runtime authorization
 *
 * Read access is least-privilege by construction: the minted
 * {@link EdgeConfigToken} is a **read-only, per-config data-plane token**
 * (plaintext disclosed once at mint) — it grants nothing beyond reading
 * this one config. No management credential ever reaches the Function.
 *
 * Writes are NOT auto-bound: the management API only accepts team/user-wide
 * tokens (live-verified — project-scoped tokens cannot see team-owned Edge
 * Configs), so runtime writes are an explicit opt-in via
 * `WriteEdgeConfigHttp({ token })` (see the security note on
 * `EdgeConfigWrite`). Prefer deploy-time declarative `items` on the
 * {@link EdgeConfig} resource where possible.
 */
export const ReadEdgeConfigHttp = Layer.effect(
  EdgeConfigRead,
  Effect.gen(function* () {
    const Token = yield* EdgeConfigToken;
    const self = yield* Self;
    const context = yield* Effect.context<HttpClient.HttpClient>();

    return Effect.fn(function* (config: EdgeConfig) {
      // Registered in BOTH phases: at plan time this adds the token to the
      // stack graph; at runtime it only rebuilds the Output expression the
      // env accessor below is keyed by.
      const token = yield* Token(
        `${self.LogicalId}${config.LogicalId}ReadToken`,
        { edgeConfigId: config.edgeConfigId },
      );
      // Env capture: at plan time this registers the connection string as
      // an env var on the host Function (Redacted ⇒ synced `sensitive`);
      // at runtime it returns an accessor reading it back from
      // `process.env` (Redacted-unpacked).
      const connection = yield* token.connectionString;
      return yield* makeReadEdgeConfigClient(connection).pipe(
        Effect.provideContext(context),
      );
    });
  }),
);
