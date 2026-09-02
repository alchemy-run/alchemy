import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The "API" side of a cross-origin dev setup: answers CORS preflights for
 * any `*.localhost` / configured origin, echoes what it sees of the request
 * (URL, forwarded headers) and sets a domain-scoped cookie — the three
 * things a browser app on a sibling subdomain needs to work locally.
 */
export default class IngressApiWorker extends Cloudflare.Worker<IngressApiWorker>()(
  "IngressApi",
  {
    main: import.meta.url,
    dev: { subdomain: "api" },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const origin = request.headers.origin;
        const cors: Record<string, string> = origin
          ? {
              "access-control-allow-origin": origin,
              "access-control-allow-credentials": "true",
              "access-control-allow-methods": "GET,POST,OPTIONS",
              "access-control-allow-headers":
                request.headers["access-control-request-headers"] ??
                "content-type",
              vary: "origin",
            }
          : {};
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: cors });
        }
        // Effect's request URL is path-only (`/echo?x=1`); anchor it.
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/cookie") {
          const domain = url.searchParams.get("domain");
          return yield* HttpServerResponse.json(
            { set: true },
            {
              headers: {
                ...cors,
                "set-cookie": `session=abc; Path=/${domain ? `; Domain=${domain}` : ""}; SameSite=Lax`,
              },
            },
          );
        }
        return yield* HttpServerResponse.json(
          {
            url: request.url,
            host: request.headers.host ?? null,
            forwardedHost: request.headers["x-forwarded-host"] ?? null,
            forwardedProto: request.headers["x-forwarded-proto"] ?? null,
            origin: origin ?? null,
            cookie: request.headers.cookie ?? null,
            method: request.method,
          },
          { headers: cors },
        );
      }),
    };
  }),
) {}
