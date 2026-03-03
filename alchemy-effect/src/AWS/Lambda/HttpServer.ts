import type { LambdaFunctionURLEvent } from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Http from "../../Http.ts";
import { Function } from "./Function.ts";

const isFunctionURLEvent = (event: any): event is LambdaFunctionURLEvent => {
  return event.requestContext?.http?.method !== undefined;
};

export const HttpServer = Layer.effect(
  Http.HttpServer,
  Effect.gen(function* () {
    const func = yield* Function.ExecutionContext;
    return Http.HttpServer.of({
      // @ts-expect-error
      serve: Effect.fn(function* (handler) {
        yield* func.listen(
          Effect.fn(function* (event) {
            if (isFunctionURLEvent(event)) {
              return yield* handler.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(toWebRequest(event)),
                ),
                Effect.orDie,
              );
            }
          }),
        );
      }),
    });
  }),
);

const toWebRequest = (event: LambdaFunctionURLEvent): Request => {
  const protocol =
    event.headers["x-forwarded-proto"] ??
    event.requestContext.http.protocol ??
    "https";
  const host = event.headers.host ?? event.requestContext.domainName;
  const url = `${protocol}://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }

  let body: string | ArrayBuffer | undefined;
  if (event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0)).buffer
      : event.body;
  }

  return new Request(url, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
};
