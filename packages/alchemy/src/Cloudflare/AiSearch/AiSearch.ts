import * as Construct from "../../Construct.ts";
import type { InputProps } from "../../Input.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { AiSearchInstance, type AiSearchInstanceProps } from "./Instance.ts";
import {
  AiSearchToken,
  type AiSearchToken as AiSearchTokenType,
} from "./Token.ts";

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
 * @section Binding to a Worker
 *
 * The returned `instance` is an {@link AiSearchInstance}, so it binds to a
 * Worker the same way any AI Search instance does: pass it under
 * `Worker.env`. The engine attaches a single-instance `ai_search` binding
 * (see `toBinding` in `WorkerAsyncBindings.ts`) and orders the deploy
 * bucket → instance → worker.
 *
 * @example Bind the instance into an async Worker's `env`
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket.bucketName,
 * });
 *
 * const worker = yield* Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: instance },
 * });
 * ```
 *
 * @example Type the async Worker's `env` with `InferEnv`
 * `InferEnv` maps an `AiSearchInstance` binding to the runtime `AutoRAG`
 * handle (an `AiSearchNamespace` maps to `{ get(name): AutoRAG }`), so the
 * worker gets a fully-typed `env.SEARCH` with no hand-written types.
 * ```typescript
 * // stack.ts
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
 *     const answer = await env.SEARCH.aiSearch({ query: "How do I deploy?" });
 *     return Response.json(answer);
 *   },
 * };
 * ```
 *
 * For an Effect-native Worker, prefer
 * `Cloudflare.AiSearchInstanceBinding.bind(instance)`, which returns an
 * Effect-native client instead of the raw `AutoRAG`.
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
