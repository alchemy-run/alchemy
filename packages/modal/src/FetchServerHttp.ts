import * as Binding from "alchemy/Binding";
import { makeFetchRpcStub } from "alchemy/Rpc";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Endpoint } from "./Endpoint.ts";
import { FetchServer, type ServerClient } from "./FetchServer.ts";
import type { Function } from "./Function.ts";
import { RPC_KEY_HEADER, RpcCaller } from "./internal/RpcAuth.ts";
import * as ModalBindings from "./ModalBindings.ts";
import type { Server } from "./Server.ts";
import { WebhookToken } from "./WebhookToken.ts";

/** The server has no URL (a Function without `web`, or a deploy still in progress). */
export class ServerUrlMissing extends Data.TaggedError("Modal.ServerUrlMissing")<{
  readonly message: string;
}> {}

/** Env the host's proxy auth token is bound under. */
const PROXY_ENV = { key: "MODAL_PROXY_KEY", secret: "MODAL_PROXY_SECRET" } as const;

/**
 * {@link FetchServer} over HTTP. Creates one `Modal.WebhookToken` per host
 * (`<host>ProxyAuth`) and binds its header pair into the host's env.
 *
 * @layer
 * @product Server
 * @provides Modal.FetchServer
 */
export const FetchServerHttp = Layer.effect(
  FetchServer,
  Effect.gen(function* () {
    // No Modal API calls: the client only needs the host's HTTP client.
    const http = yield* ModalBindings.withCredentials(HttpClient.HttpClient);
    const bind = yield* ModalBindings.Bind;
    const runtime = yield* CurrentRuntimeContext;
    // Deploy only: a host bundle never creates the token.
    const Token = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* WebhookToken;
    const caller = yield* RpcCaller;

    return Effect.fn("Modal.FetchServer")(function* (server: Server | Function | Endpoint) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined && Token !== undefined) {
          const token = yield* Token(`${host.LogicalId}ProxyAuth`, {});
          yield* bind`Modal.FetchServer(${server})`({
            env: { [PROXY_ENV.key]: token.tokenId, [PROXY_ENV.secret]: token.tokenSecret },
          });
        }
      }
      // This host's key for the Server's RPC methods (minted at deploy).
      const key = yield* caller(server);
      const url = yield* server.url;
      const resolvedUrl = Effect.flatMap(url, (value) =>
        value
          ? Effect.succeed(value)
          : Effect.fail(
              new ServerUrlMissing({
                message:
                  "The server has no URL: deploy it as a Modal.Server, a Modal.Function with web, or a Modal.Endpoint",
              }),
            ),
      );
      const headers = Effect.gen(function* () {
        if (runtime === undefined) return {};
        const key = yield* runtime.get<string>(PROXY_ENV.key);
        const secret = yield* runtime.get<string | Redacted.Redacted<string>>(PROXY_ENV.secret);
        if (key === undefined || secret === undefined) return {};
        return {
          "Modal-Key": key,
          "Modal-Secret": Redacted.isRedacted(secret) ? Redacted.value(secret) : secret,
        };
      });
      const client = {
        url: resolvedUrl,
        fetch: (request) =>
          Effect.gen(function* () {
            const base = yield* resolvedUrl;
            const target = new URL(request.url, "http://server");
            // The Stack's own deployed server (allowed raw HTTP).
            return yield* http.execute(
              request.pipe(
                HttpClientRequest.setUrl(
                  `${base.replace(/\/$/, "")}${target.pathname}${target.search}`,
                ),
                HttpClientRequest.setHeaders(yield* headers),
              ),
            );
          }),
      } satisfies ServerClient;
      // Every other member is an RPC method of the Server's program.
      return makeFetchRpcStub<ServerClient>({
        // RPC calls carry the key; the Server serves only callers it issued keys to.
        fetch: (request) =>
          Effect.flatMap(key, (value) =>
            client.fetch(
              value === undefined
                ? request
                : request.pipe(HttpClientRequest.setHeader(RPC_KEY_HEADER, value)),
            ),
          ),
        base: client,
      });
    });
  }),
);
