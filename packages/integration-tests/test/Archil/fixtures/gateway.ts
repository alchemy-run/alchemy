import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

/** Fake values: the test checks that each reaches only its own side. */
export const GATEWAY_TOKEN = "fake-gateway-token-7f3a";
export const API_KEY = "fake-api-key-9c1e";

/** The only hosts the gateway forwards to. */
const UPSTREAMS = ["postman-echo.com"];

/**
 * An egress gateway for Archil sandboxes. Archil forwards a sandbox's
 * request here (`forwardUrl`), naming the original destination in
 * `archil-forwarded-*` headers and adding the gateway token from the
 * egress rule. The gateway checks the token, adds the API key, and sends
 * the request on. Neither secret is ever inside the sandbox.
 */
export default class EgressGateway extends Cloudflare.Worker<EgressGateway>()(
  "EgressGateway",
  {
    main: import.meta.url,
    env: {
      GATEWAY_TOKEN: Redacted.make(GATEWAY_TOKEN),
      API_KEY: Redacted.make(API_KEY),
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const env = yield* Cloudflare.Workers.WorkerEnvironment;
        const header = (name: string) => request.headers[name];

        if (header("x-gateway-token") !== env.GATEWAY_TOKEN) {
          return HttpServerResponse.text("forbidden", { status: 403 });
        }
        const host = header("archil-forwarded-host");
        if (host === undefined || !UPSTREAMS.includes(host)) {
          return HttpServerResponse.text(`host not allowed: ${host}`, { status: 403 });
        }

        // Archil appends the original path and query to the forward URL.
        const url = new URL(request.originalUrl);
        const scheme = header("archil-forwarded-scheme") ?? "https";
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            ([name]) =>
              !name.startsWith("archil-") && name !== "x-gateway-token" && name !== "host",
          ),
        );
        const body = new Uint8Array(yield* request.arrayBuffer);
        const client = yield* HttpClient.HttpClient;
        const upstream = yield* client.execute(
          HttpClientRequest.make(request.method as "GET")(
            `${scheme}://${host}${url.pathname}${url.search}`,
          ).pipe(
            HttpClientRequest.setHeaders({ ...headers, "x-api-key": env.API_KEY }),
            body.byteLength > 0 ? HttpClientRequest.bodyUint8Array(body) : (r) => r,
          ),
        );
        return HttpServerResponse.text(yield* upstream.text, {
          status: upstream.status,
          contentType: upstream.headers["content-type"],
          headers: { "x-gateway-sandbox": header("archil-sandbox-id") ?? "" },
        });
      }).pipe(
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 502 })),
        ),
      ),
    };
  }),
) {}
