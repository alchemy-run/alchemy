import * as Operations from "@distilled.cloud/axiom/Operations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type ApiTokenProps = Omit<Operations.CreateAPITokenInput, never>;

export type ApiToken = Resource<
  "Axiom.ApiToken",
  ApiTokenProps,
  Omit<Operations.CreateAPITokenOutput, "token"> & {
    /**
     * The bearer token. Returned only by `create` (and `regenerate`); Axiom
     * does not return it on subsequent reads. Persisted in resource state via
     * `Redacted` — handle with care.
     */
    token: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * An Axiom API token — a scoped bearer token used to authenticate API
 * requests (ingest, query, admin). Capabilities are pinned at creation time;
 * changing any field triggers a **replacement** because Axiom does not
 * expose an update endpoint.
 *
 * The raw token value is returned only by `create`. After that, Axiom
 * never echoes it back, so it is captured into `output.token` (as a
 * {@link Redacted}) on initial create and persisted in resource state.
 * Treat resource state as sensitive — anyone with read access can recover
 * the token. Pair with a secret store for downstream consumption.
 *
 * @see https://axiom.co/docs/reference/tokens
 *
 * @section Creating an API Token
 * @example Ingest-only token scoped to one dataset
 * ```typescript
 * const ingest = yield* Axiom.ApiToken("ingest", {
 *   name: "prod-ingest",
 *   description: "OTEL collector ingest",
 *   datasetCapabilities: {
 *     "my-app-traces": { ingest: ["create"] },
 *   },
 * });
 * ```
 *
 * @example Read-only query token
 * ```typescript
 * yield* Axiom.ApiToken("query", {
 *   name: "grafana-reader",
 *   datasetCapabilities: {
 *     "my-app-traces": { query: ["read"] },
 *     "my-app-logs":   { query: ["read"] },
 *   },
 * });
 * ```
 *
 * @section Consuming the Token
 * @example Forward the token via Cloudflare Secrets
 * ```typescript
 * const secret = yield* Cloudflare.Secret("axiom-token", {
 *   value: ingest.token,
 * });
 * ```
 */
export const ApiToken = Resource<ApiToken>("Axiom.ApiToken");

export const ApiTokenProvider = () =>
  Provider.effect(
    ApiToken,
    Effect.gen(function* () {
      const create = yield* Operations.createAPIToken;
      const get = yield* Operations.getAPIToken;
      const del = yield* Operations.deleteAPIToken;

      return {
        stables: ["id", "token"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          // First create — let the engine create normally.
          if (output == null) return undefined;
          // Axiom has no update endpoint for tokens — every subsequent
          // change is a replacement so the caller gets a fresh token value.
          return { action: "replace" } as const;
        }),
        create: Effect.fn(function* ({ news }) {
          const result = yield* create(news);
          if (!result.token) {
            return yield* Effect.die(
              new Error("Axiom did not return a token on create"),
            );
          }
          return {
            ...result,
            token: Redacted.make(result.token),
          };
        }),
        update: Effect.fn(function* ({ output }) {
          // Diff returns "replace" for every change, so update should never
          // run. If invoked, just return current state unchanged.
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.map((current) => ({ ...current, token: output.token })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
