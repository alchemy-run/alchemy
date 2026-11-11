import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers.ts";

export interface SandboxPortTokenProps {
  /** Sandbox id (e.g. `sandbox.sandboxId`). Changing it replaces the token. */
  sandbox: string;
  /** The exposed port the token opens. Changing it replaces the token. */
  port: number;
  /**
   * How long the token lasts, e.g. `"24h"` or `"30m"`. Omit for a token
   * that lasts until revoked. Changing it replaces the token.
   */
  ttl?: string;
}

export interface SandboxPortTokenAttributes {
  /** Token id. */
  tokenId: string;
  sandboxId: string;
  port: number;
  /** Hostname the token opens. */
  hostname: string;
  /** The token. Send it with requests to `hostname`. */
  token: Redacted.Redacted<string>;
  /** When the token expires, if it does. */
  expiresAt: string | undefined;
}

export type SandboxPortToken = Resource<
  "Archil.SandboxPortToken",
  SandboxPortTokenProps,
  SandboxPortTokenAttributes,
  never,
  Providers
>;

/**
 * A token that opens one exposed port of one sandbox, for a client that
 * shouldn't hold your API key. Archil only shows the token once, so Alchemy
 * stores it in state as a `Redacted` value; destroying the resource revokes
 * it.
 * @see https://docs.archil.com/compute/sandboxes/introduction
 *
 * ### Creating a Port Token
 * **Example:** A day-long token for a preview
 * ```typescript
 * const token = yield* Archil.SandboxPortToken("PreviewToken", {
 *   sandbox: preview.sandboxId,
 *   port: 3000,
 *   ttl: "24h",
 * });
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const SandboxPortToken = Resource<SandboxPortToken>("Archil.SandboxPortToken");

/** Mint a port token. */
export const createPortToken = Effect.fn(function* (sid: string, port: number, ttl?: string) {
  const { data } = yield* archil.createSandboxPortToken({ sid, port, ttl });
  return {
    tokenId: data.id,
    sandboxId: sid,
    port: data.port,
    hostname: data.hostname,
    token: typeof data.token === "string" ? Redacted.make(data.token) : data.token,
    expiresAt: data.expires_at,
  } satisfies SandboxPortTokenAttributes;
});

/** Revoke a port token. Revoking a missing token succeeds. */
export const revokePortToken = (sid: string, tokenId: string) =>
  archil.deleteSandboxPortToken({ sid, token_id: tokenId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const SandboxPortTokenProvider = () =>
  Provider.effect(
    SandboxPortToken,
    Effect.gen(function* () {
      return {
        stables: ["tokenId", "sandboxId", "port", "hostname", "token", "expiresAt"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (news.sandbox !== olds.sandbox || news.port !== olds.port || news.ttl !== olds.ttl) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* archil
            .getSandboxPortToken({ sid: output.sandboxId, token_id: output.tokenId })
            .pipe(
              Effect.map(() => output),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — a live token we minted is kept; tokens can't be updated.
          if (output) {
            const live = yield* archil
              .getSandboxPortToken({ sid: output.sandboxId, token_id: output.tokenId })
              .pipe(
                Effect.as(true),
                Effect.catchTag("NotFound", () => Effect.succeed(false)),
              );
            if (live) return output;
          }
          // Ensure
          return yield* createPortToken(news.sandbox, news.port, news.ttl);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* revokePortToken(output.sandboxId, output.tokenId);
        }),
      };
    }),
  );
