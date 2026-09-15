import { makeRequestEffect } from "@/Cloudflare/Workers/HttpServer.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * In-process pin of the Raw web `Response` contract: a handler that answers
 * with a native `Response` gets the same status and headers on GET and HEAD,
 * including what a pre-response handler set after the handler returned. A
 * native response nothing mutated, and an upgrade response, are handed to
 * the client as the object they are.
 */
type PreResponse = (
  response: HttpServerResponse.HttpServerResponse,
) => HttpServerResponse.HttpServerResponse;

const handler = (
  respond: () => HttpServerResponse.HttpServerResponse,
  preResponse?: PreResponse,
) =>
  Effect.gen(function* () {
    if (preResponse) {
      yield* EffectHttp.appendPreResponseHandler((_, response) =>
        Effect.succeed(preResponse(response)),
      );
    }
    return respond();
  });

// `makeRequestEffect` is typed `as any` at its return; pin R to `never`.
const handle = (
  method: "GET" | "HEAD",
  respond: () => HttpServerResponse.HttpServerResponse,
  preResponse?: PreResponse,
): Effect.Effect<Response> =>
  makeRequestEffect<never>(
    new Request("https://worker.test/raw", { method }) as any,
    handler(respond, preResponse),
  );

const setCookieHeaders = (response: Response) =>
  [...response.headers]
    .filter(([name]) => name === "set-cookie")
    .map(([, value]) => value);

describe("a Raw web Response answers with the Effect-level status and headers", () => {
  it.effect(
    "GET and HEAD agree on a status set by a pre-response handler",
    () =>
      Effect.gen(function* () {
        const respond = () =>
          HttpServerResponse.raw(new Response("onetwo", { status: 202 }));
        const setTeapot: PreResponse = (response) =>
          HttpServerResponse.setStatus(response, 418);

        const get = yield* handle("GET", respond, setTeapot);
        expect(get.status).toBe(418);
        expect(yield* Effect.promise(() => get.text())).toBe("onetwo");

        const head = yield* handle("HEAD", respond, setTeapot);
        expect(head.status).toBe(418);
        expect(head.body).toBeNull();
      }),
  );

  it.effect("a pre-response handler sees the native status and headers", () =>
    Effect.gen(function* () {
      const seen: Array<[number, string | undefined]> = [];
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.raw(
            new Response("body", {
              status: 202,
              headers: { "x-native": "yes" },
            }),
          ),
        (response) => {
          seen.push([response.status, response.headers["x-native"]]);
          return response;
        },
      );
      expect(seen).toEqual([[202, "yes"]]);
      expect(response.status).toBe(202);
    }),
  );

  it.effect("HEAD answers with the native status when nothing was set", () =>
    Effect.gen(function* () {
      const response = yield* handle("HEAD", () =>
        HttpServerResponse.raw(
          new Response("body", { status: 202, headers: { "x-native": "yes" } }),
        ),
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("x-native")).toBe("yes");
      expect(response.body).toBeNull();
    }),
  );

  it.effect("keeps both native Set-Cookie headers after the merge", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.raw(
            new Response("body", {
              status: 200,
              headers: [
                ["set-cookie", "a=1"],
                ["set-cookie", "b=2"],
              ],
            }),
          ),
        (response) => HttpServerResponse.setHeader(response, "x-added", "1"),
      );
      expect(response.headers.get("x-added")).toBe("1");
      expect(setCookieHeaders(response)).toEqual(["a=1", "b=2"]);
    }),
  );

  it.effect("appends Effect-level cookies next to the native ones", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.raw(
            new Response("body", { headers: { "set-cookie": "a=1" } }),
          ),
        (response) =>
          HttpServerResponse.setCookieUnsafe(response, "session", "abc", {
            path: "/",
          }),
      );
      expect(setCookieHeaders(response)).toEqual([
        "a=1",
        "session=abc; Path=/",
      ]);
    }),
  );

  it.effect("an Effect header overrides a native header of the same name", () =>
    Effect.gen(function* () {
      const native = () =>
        new Response("body", {
          headers: { "x-a": "native", "x-keep": "native" },
        });

      const constructed = yield* handle("GET", () =>
        HttpServerResponse.raw(native(), { headers: { "X-A": "constructed" } }),
      );
      expect(constructed.headers.get("x-a")).toBe("constructed");
      expect(constructed.headers.get("x-keep")).toBe("native");

      const mutated = yield* handle(
        "GET",
        () => HttpServerResponse.raw(native()),
        (response) => HttpServerResponse.setHeader(response, "X-A", "later"),
      );
      expect(mutated.headers.get("x-a")).toBe("later");
      expect(mutated.headers.get("x-keep")).toBe("native");
    }),
  );

  it.effect("drops a native header a pre-response handler removed", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.raw(
            new Response("body", { headers: { "x-a": "native" } }),
          ),
        (response) => HttpServerResponse.removeHeader(response, "x-a"),
      );
      expect(response.headers.has("x-a")).toBe(false);
    }),
  );

  it.effect("returns the native Response untouched without a mutation", () =>
    Effect.gen(function* () {
      const native = new Response("body", {
        status: 202,
        headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
          ["x-native", "yes"],
        ],
      });
      const response = yield* handle(
        "GET",
        () => HttpServerResponse.raw(native),
        (response) => response,
      );
      expect(response).toBe(native);
    }),
  );

  it.effect("returns a 101 upgrade Response untouched", () =>
    Effect.gen(function* () {
      const native = new Response(null, { status: 101 });
      const response = yield* handle(
        "GET",
        () => HttpServerResponse.raw(native),
        (response) => HttpServerResponse.setHeader(response, "x-added", "1"),
      );
      expect(response).toBe(native);
    }),
  );

  it.effect("does not read a streamed native body it rebuilds over", () =>
    Effect.gen(function* () {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      });
      const response = yield* handle(
        "GET",
        () => HttpServerResponse.raw(new Response(stream, { status: 202 })),
        (response) => HttpServerResponse.setStatus(response, 418),
      );
      expect(response.status).toBe(418);
      // The same stream object, untouched: the client pulls the first chunk.
      expect(response.body).toBe(stream);
      expect(pulls).toBe(0);
      expect(stream.locked).toBe(false);
      expect(yield* Effect.promise(() => response.text())).toBe("streamed");
      expect(pulls).toBe(1);
    }),
  );
});
