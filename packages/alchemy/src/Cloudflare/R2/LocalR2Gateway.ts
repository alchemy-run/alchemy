/**
 * Node-side path into the local workerd R2 simulator.
 *
 * The `*Local` R2 capability layers speak the Cloudflare R2 REST API via
 * distilled ops. For a `dev:` bucket there is no cloud bucket — so this
 * gateway boots an ephemeral workerd with the native R2 binding and
 * EMULATES the REST endpoints the client builders call, over that binding:
 *
 *   Node ── R2 REST op ──▶ gateway worker ──▶ env.R2 ──▶ simulator
 *
 * The ops run unchanged: {@link authorizeThroughLocalR2Gateway} rebases the
 * op's HttpClient onto the gateway URL for the duration of one operation.
 * Data lands in the same `{storage}/r2` directory every local worker
 * binding reads.
 *
 * NOT exported from `index.ts` — capability-internal scaffolding.
 */
import { R2Bucket } from "@distilled.cloud/cloudflare-runtime/bindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Credentials } from "../Credentials.ts";
import {
  gatewayName,
  localGatewayRuntime,
  rebaseHttpClient,
  withLocalGateway,
} from "../LocalGateway.ts";

/**
 * REST-surface emulation of the R2 HTTP API over the native binding.
 * Covers exactly the operations the alchemy R2 client builders use:
 *
 * - `GET    …/objects/{key}` → raw body + metadata headers (404 NoSuchKey)
 * - `PUT    …/objects/{key}` → raw body, content headers become httpMetadata
 * - `DELETE …/objects/{key}`
 * - `DELETE …/objects`       → JSON array body of keys (bulk delete)
 * - `GET    …/objects`       → envelope list with cursor result_info
 *
 * Response envelopes mirror the cloud API so distilled's decoders and typed
 * error matchers (NoSuchKey = 404 + "specified key does not exist") work
 * identically against the simulator.
 */
const GATEWAY_MODULE = `const envelope = (result, extra = {}) =>
  Response.json({ success: true, errors: [], messages: [], result, ...extra });
const failure = (status, code, message) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );

const listEntry = (o) => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  last_modified: o.uploaded ? o.uploaded.toISOString() : undefined,
  storage_class: o.storageClass ?? "Standard",
  custom_metadata: o.customMetadata ?? {},
  http_metadata: o.httpMetadata ?? {},
});

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(
        /\\/r2\\/buckets\\/[^/]+\\/objects(?:\\/(.*))?$/,
      );
      if (!match) return failure(404, 10001, "no route for " + url.pathname);
      const key = match[1] === undefined ? undefined : decodeURIComponent(match[1]);

      if (request.method === "GET" && key !== undefined) {
        const object = await env.R2.get(key);
        if (object === null) {
          return failure(404, 10007, "The specified key does not exist.");
        }
        const headers = new Headers();
        headers.set("etag", object.etag);
        headers.set("content-length", String(object.size));
        const meta = object.httpMetadata ?? {};
        headers.set(
          "content-type",
          meta.contentType ?? "application/octet-stream",
        );
        if (meta.contentEncoding) headers.set("content-encoding", meta.contentEncoding);
        if (meta.contentDisposition) headers.set("content-disposition", meta.contentDisposition);
        if (meta.contentLanguage) headers.set("content-language", meta.contentLanguage);
        if (meta.cacheControl) headers.set("cache-control", meta.cacheControl);
        if (meta.cacheExpiry) headers.set("expires", meta.cacheExpiry.toUTCString());
        if (object.uploaded) headers.set("last-modified", object.uploaded.toUTCString());
        if (object.storageClass) headers.set("cf-r2-storage-class", object.storageClass);
        return new Response(object.body, { headers });
      }

      if (request.method === "GET") {
        const list = await env.R2.list({
          prefix: url.searchParams.get("prefix") ?? undefined,
          delimiter: url.searchParams.get("delimiter") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          startAfter: url.searchParams.get("start_after") ?? undefined,
          limit: url.searchParams.get("per_page")
            ? Number(url.searchParams.get("per_page"))
            : undefined,
        });
        return envelope(list.objects.map(listEntry), {
          result_info: {
            count: list.objects.length,
            cursor: list.truncated ? list.cursor : "",
            per_page: url.searchParams.get("per_page")
              ? Number(url.searchParams.get("per_page"))
              : null,
          },
        });
      }

      if (request.method === "PUT" && key !== undefined) {
        const httpMetadata = {};
        const contentType = request.headers.get("content-type");
        if (contentType) httpMetadata.contentType = contentType;
        const contentEncoding = request.headers.get("content-encoding");
        if (contentEncoding) httpMetadata.contentEncoding = contentEncoding;
        const contentDisposition = request.headers.get("content-disposition");
        if (contentDisposition) httpMetadata.contentDisposition = contentDisposition;
        const contentLanguage = request.headers.get("content-language");
        if (contentLanguage) httpMetadata.contentLanguage = contentLanguage;
        const cacheControl = request.headers.get("cache-control");
        if (cacheControl) httpMetadata.cacheControl = cacheControl;
        const expires = request.headers.get("expires");
        if (expires) httpMetadata.cacheExpiry = new Date(expires);
        // Buffer the body: R2.put needs a known length, and the incoming
        // request may be chunked.
        const body = await request.arrayBuffer();
        const object = await env.R2.put(key, body, {
          httpMetadata,
          storageClass:
            request.headers.get("cf-r2-storage-class") ?? undefined,
        });
        return envelope({
          key,
          etag: object?.etag,
          size: object?.size,
        });
      }

      if (request.method === "DELETE" && key !== undefined) {
        await env.R2.delete(key);
        return envelope({});
      }

      if (request.method === "DELETE") {
        const keys = await request.json();
        if (!Array.isArray(keys)) {
          return failure(400, 10001, "bulk delete expects a JSON array of keys");
        }
        await env.R2.delete(keys);
        return envelope(keys.map((k) => ({ key: k })));
      }

      return failure(405, 10001, "unsupported " + request.method);
    } catch (e) {
      return failure(
        500,
        10001,
        "local R2 gateway failed: " + (e && e.message ? e.message : String(e)),
      );
    }
  },
};`;

/**
 * Run one distilled R2 op against the local simulator: boot an ephemeral
 * gateway for `bucketName`, rebase the op's HttpClient onto it (Credentials
 * come from the captured ambient context — the gateway ignores auth
 * headers), and tear the gateway down afterwards.
 *
 * One boot per operation — slow but correct; the `*Local` layers run in
 * deploy-time Actions, not on a request path.
 */
export const authorizeThroughLocalR2Gateway = <A, E>(
  bucketName: string,
  eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  /**
   * The FULL ambient stack-eval context: platform services for booting
   * workerd, `CloudflareEnvironment`/`AlchemyContext` for the runtime
   * layer, and `Credentials`/`HttpClient` for the op itself.
   */
  ambient: Context.Context<never>,
): Effect.Effect<A, E> =>
  withLocalGateway(
    {
      name: gatewayName("alchemy-r2-gateway", bucketName),
      modules: [
        { name: "gateway.js", type: "ESModule", content: GATEWAY_MODULE },
      ],
      bindings: [R2Bucket.local({ binding: "R2", id: bucketName })],
    },
    (url) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* eff.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            rebaseHttpClient(client, url),
          ),
          Effect.provideContext(ambient),
        );
      }),
  ).pipe(
    Effect.provide(localGatewayRuntime),
    // The gateway layer's platform requirements are satisfied by the
    // ambient stack-eval context; `Context<never>` can't prove that
    // statically, so erase the leftover R (and the gateway's own infra
    // error channel) with a cast — mirroring D1's `QueryDatabaseLocal`.
    Effect.provideContext(ambient),
  ) as unknown as Effect.Effect<A, E>;
