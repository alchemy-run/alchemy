/**
 * Node-side path into the local workerd KV simulator.
 *
 * The `*Local` KV capability layers speak the Cloudflare KV REST API via
 * distilled ops. For a `dev:` namespace there is no cloud namespace — so
 * this gateway boots an ephemeral workerd with the native KV binding and
 * EMULATES the REST endpoints the client builders call, over that binding:
 *
 *   Node ── KV REST op ──▶ gateway worker ──▶ env.KV ──▶ simulator
 *
 * The ops run unchanged: {@link authorizeThroughLocalKVGateway} rebases the
 * op's HttpClient onto the gateway URL for the duration of one operation.
 * Data lands in the same `{storage}/kv` directory every local worker
 * binding reads.
 *
 * NOT exported from `index.ts` — capability-internal scaffolding.
 */
import { KvNamespace } from "@distilled.cloud/cloudflare-runtime/bindings";
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
 * REST-surface emulation of the KV HTTP API over the native binding.
 * Covers exactly the operations the alchemy KV client builders use:
 *
 * - `GET    …/values/{key}`     → raw value bytes (404 code 10009 when absent)
 * - `PUT    …/values/{key}`     → multipart value+metadata, expiration query
 * - `DELETE …/values/{key}`
 * - `GET    …/metadata/{key}`   → envelope with the key's metadata
 * - `GET    …/keys`             → envelope list with cursor result_info
 * - `POST   …/bulk/get`         → envelope `{ values }` map
 *
 * Response envelopes mirror the cloud API (`{ success, errors, messages,
 * result }`) so distilled's decoders and typed error matchers (KeyNotFound
 * = code 10009) work identically against the simulator.
 */
const GATEWAY_MODULE = `const envelope = (result, extra = {}) =>
  Response.json({ success: true, errors: [], messages: [], result, ...extra });
const failure = (status, code, message) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(
        /\\/storage\\/kv\\/namespaces\\/[^/]+\\/(values|metadata|keys|bulk)(?:\\/(.*))?$/,
      );
      if (!match) return failure(404, 7003, "no route for " + url.pathname);
      const [, route, rest] = match;
      const key = rest === undefined ? undefined : decodeURIComponent(rest);

      if (route === "values" && request.method === "GET") {
        const value = await env.KV.get(key, "stream");
        if (value === null) return failure(404, 10009, "key not found");
        return new Response(value, {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      if (route === "values" && request.method === "PUT") {
        const form = await request.formData();
        const value = form.get("value");
        const metadataRaw = form.get("metadata");
        const options = {};
        const expiration = url.searchParams.get("expiration");
        if (expiration) options.expiration = Number(expiration);
        const expirationTtl = url.searchParams.get("expiration_ttl");
        if (expirationTtl) options.expirationTtl = Number(expirationTtl);
        if (typeof metadataRaw === "string" && metadataRaw !== "") {
          options.metadata = JSON.parse(metadataRaw);
        }
        await env.KV.put(
          key,
          typeof value === "string" ? value : value.stream(),
          options,
        );
        return envelope({});
      }

      if (route === "values" && request.method === "DELETE") {
        await env.KV.delete(key);
        return envelope({});
      }

      if (route === "metadata" && request.method === "GET") {
        const { value, metadata } = await env.KV.getWithMetadata(key, "stream");
        if (value === null && metadata === null) {
          return failure(404, 10009, "key not found");
        }
        return envelope(metadata ?? null);
      }

      if (route === "keys" && request.method === "GET") {
        const list = await env.KV.list({
          prefix: url.searchParams.get("prefix") ?? undefined,
          limit: url.searchParams.get("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        return envelope(
          list.keys.map((k) => ({
            name: k.name,
            expiration: k.expiration,
            metadata: k.metadata,
          })),
          {
            result_info: {
              count: list.keys.length,
              cursor: list.list_complete ? "" : list.cursor,
            },
          },
        );
      }

      if (route === "bulk" && rest === "get" && request.method === "POST") {
        const body = await request.json();
        const type = body.type === "json" ? "json" : "text";
        const values = {};
        for (const k of body.keys ?? []) {
          const value = await env.KV.get(k, type);
          if (value === null) continue;
          if (body.withMetadata) {
            const { metadata } = await env.KV.getWithMetadata(k);
            values[k] = { value, metadata: metadata ?? null };
          } else {
            values[k] = value;
          }
        }
        return envelope({ values });
      }

      return failure(405, 7003, "unsupported " + request.method + " " + route);
    } catch (e) {
      return failure(
        500,
        7000,
        "local KV gateway failed: " + (e && e.message ? e.message : String(e)),
      );
    }
  },
};`;

/**
 * Run one distilled KV op against the local simulator: boot an ephemeral
 * gateway for `namespaceId`, rebase the op's HttpClient onto it (Credentials
 * come from the captured ambient context — the gateway ignores auth
 * headers), and tear the gateway down afterwards.
 *
 * One boot per operation — slow but correct; the `*Local` layers run in
 * deploy-time Actions, not on a request path.
 */
export const authorizeThroughLocalKVGateway = <A, E>(
  namespaceId: string,
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
      name: gatewayName("alchemy-kv-gateway", namespaceId),
      modules: [
        { name: "gateway.js", type: "ESModule", content: GATEWAY_MODULE },
      ],
      bindings: [KvNamespace.local({ binding: "KV", id: namespaceId })],
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
