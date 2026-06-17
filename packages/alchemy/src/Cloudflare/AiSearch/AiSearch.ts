import * as Construct from "../../Construct.ts";
import type { InputProps } from "../../Input.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  AiSearchInstance,
  type AiSearchInstanceProps,
} from "./AiSearchInstance.ts";
import {
  AiSearchToken,
  type AiSearchToken as AiSearchTokenType,
} from "./AiSearchToken.ts";

// Constructs don't auto-wrap props in `Input` (only the underlying `Resource`
// does), so wrap the instance props here to accept `Output` values from
// callers (e.g. `source: bucket.bucketName`). `type` stays a plain literal so
// the runtime discriminant check below works.
export type AiSearchProps = InputProps<AiSearchInstanceProps, "type"> & {
  /**
   * How the AI Search service token used to read an R2 data source is
   * provisioned:
   * - `"managed"` (default): mint a least-privilege Cloudflare API token
   *   (the `AI Search Index Engine` permission group) plus the AI Search
   *   service token wrapping it, as stable children of this construct, and
   *   wire its id into the instance.
   * - `"auto"`: skip the managed token and let Cloudflare auto-provision
   *   one for the instance.
   *
   * Ignored when an explicit `tokenId` is supplied, or for non-R2 sources
   * (web crawler / built-in storage), which don't use a service token.
   * @default "managed"
   */
  token?: "managed" | "auto";
};

/**
 * A convenience construct over {@link AiSearchInstance} that auto-creates the
 * sub-resources an AI Search instance typically needs, so a single call wires
 * up a working pipeline:
 *
 * - For an R2 source with no explicit `tokenId`, it mints a least-privilege
 *   {@link AccountApiToken} (`AI Search Index Engine`) and an
 *   {@link AiSearchToken} wrapping it (stable children `Token`), then passes
 *   that token to the instance.
 * - It creates the {@link AiSearchInstance} (child `Instance`) with the
 *   remaining props.
 *
 * Drop down to the low-level resources directly when you need to share a
 * token across instances, adopt an existing one, or bind a namespace.
 *
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating an AI Search pipeline
 * @example R2-backed instance with an auto-provisioned token
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket.bucketName,
 * });
 * ```
 *
 * @example Let Cloudflare auto-provision the token
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket.bucketName,
 *   token: "auto",
 * });
 * ```
 *
 * @section Binding to an Effect Worker
 *
 * The returned `instance` is an {@link AiSearchInstance}. Bind it during the
 * Worker's init phase with `Cloudflare.AiSearchInstance.bind(instance)`, which
 * attaches the single-instance `ai_search` binding and hands back an
 * Effect-native client whose `search` / `aiSearch` methods return `Effect`s.
 * Provide `AiSearchInstanceBindingLive` in the Worker's runtime layer.
 *
 * @example Effect Worker that answers from AI Search
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "api",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const bucket = yield* Cloudflare.R2Bucket("docs", {});
 *     const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *       source: bucket.bucketName,
 *     });
 *     const search = yield* Cloudflare.AiSearchInstance.bind(instance);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const query = new URL(request.url).searchParams.get("q") ?? "";
 *         const answer = yield* search.aiSearch({ query });
 *         return yield* HttpServerResponse.json(answer);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AiSearchInstanceBindingLive)),
 * ) {}
 * ```
 *
 * @section Binding to an Async Worker
 *
 * For a vanilla `async fetch` Worker, pass the `instance` under `Worker.env`.
 * The engine attaches the same single-instance `ai_search` binding (see
 * `toBinding` in `WorkerAsyncBindings.ts`), orders the deploy
 * bucket → instance → worker, and `InferEnv` types `env.SEARCH` as the
 * runtime `AutoRAG` handle — no hand-written types.
 *
 * @example Async Worker that answers from AI Search
 * ```typescript
 * // stack.ts
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket.bucketName,
 * });
 *
 * export const Api = Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: instance },
 * });
 * export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
 *
 * // worker.ts
 * import type { ApiEnv } from "./stack.ts";
 * export default {
 *   async fetch(request: Request, env: ApiEnv): Promise<Response> {
 *     const query = new URL(request.url).searchParams.get("q") ?? "";
 *     const answer = await env.SEARCH.aiSearch({ query });
 *     return Response.json(answer);
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const AiSearch = Construct.fn(function* (
  id: string,
  props: AiSearchProps,
) {
  const { token, ...instanceProps } = props;

  let tokenId = instanceProps.tokenId;
  let serviceToken: AiSearchTokenType | undefined;

  // Mint a managed service token for R2 sources unless the caller pinned a
  // `tokenId` or opted into Cloudflare's auto-provisioned token.
  if (
    tokenId === undefined &&
    (token ?? "managed") === "managed" &&
    (instanceProps.type ?? "r2") === "r2"
  ) {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const apiToken = yield* AccountApiToken("Token", {
      policies: [
        {
          effect: "allow",
          permissionGroups: ["AI Search Index Engine"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    });
    serviceToken = yield* AiSearchToken("Token", {
      cfApiId: apiToken.tokenId,
      cfApiKey: apiToken.value,
    });
    tokenId = serviceToken.id;
  }

  const instance = yield* AiSearchInstance("Instance", {
    ...instanceProps,
    tokenId,
  });

  return { instance, token: serviceToken };
});
