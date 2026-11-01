import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import type { Function } from "./Function.ts";
import { FunctionUrlMissing, Invoke, type InvokeRequest } from "./Invoke.ts";

const trimEnd = (url: string) => url.replace(/\/+$/, "");

const withLeadingSlash = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const contentTypeOf = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1];

/**
 * HTTP implementation of {@link Invoke}.
 *
 * @layer
 * @provides Stackit.Functions.Invoke
 */
export const InvokeHttp = Layer.effect(
  Invoke,
  Effect.succeed(
    Effect.fn(function* (fn: Function<any>) {
      const functionName = yield* fn.name;
      const functionUrl = yield* fn.url;
      return Effect.fn("Stackit.Functions.Invoke")(function* (request: InvokeRequest = {}) {
        const url = yield* functionUrl;
        if (url === undefined) {
          const name = yield* functionName;
          return yield* new FunctionUrlMissing({
            functionName: name,
            message: `STACKIT function ${name} has no URL to invoke`,
          });
        }
        // Raw HttpClient: the user's own deployed endpoint, at the URL the
        // Functions API hands back. This is not a STACKIT API call.
        const base = HttpClientRequest.make(request.method ?? "GET")(
          `${trimEnd(url)}${withLeadingSlash(request.path ?? "/")}`,
        ).pipe(HttpClientRequest.setHeaders(request.headers ?? {}));
        return yield* HttpClient.execute(
          request.body === undefined
            ? base
            : HttpClientRequest.bodyText(base, request.body, contentTypeOf(request.headers)),
        ).pipe(Effect.provide(FetchHttpClient.layer));
      });
    }),
  ),
);
