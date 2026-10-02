import * as Cloudflare from "@/Cloudflare/index.ts";
import { makeRequestEffect } from "@/Cloudflare/Workers/HttpServer.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import RawResponseWorker from "./fixtures/raw-response/worker.ts";

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
    return yield* Effect.sync(respond);
  });

// `makeRequestEffect` is typed `as any` at its return; pin R to `never`.
const handle = (
  method: "GET" | "HEAD",
  respond: () => HttpServerResponse.HttpServerResponse,
  preResponse?: PreResponse,
): Effect.Effect<Response> =>
  Effect.flatMap(
    Effect.sync(() => new Request("https://worker.test/response", { method })),
    (request) =>
      makeRequestEffect<never>(request as any, handler(respond, preResponse)),
  );

for (const dev of [false, true]) {
  const { test } = Test.make({ providers: Cloudflare.providers(), dev });

  test.provider(
    `web responses over HTTP (${dev ? "local" : "live"})`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const worker = yield* stack.deploy(RawResponseWorker);
        const client = yield* HttpClient.HttpClient;
        const ready = yield* client.get(`${worker.url!}/ready`).pipe(
          Effect.flatMap((response) => response.text),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (body) => body === "raw-response:ready",
          }),
        );
        expect(ready).toBe("raw-response:ready");

        for (const path of [
          "/status",
          "/native",
          "/constructed-header",
          "/explicit-status",
          "/cookie",
          "/stream",
          "/no-content",
          "/reset-content",
          "/not-modified",
        ]) {
          for (const method of ["GET", "HEAD"] as const) {
            const url = `${worker.url!}${path}`;
            // Routes can propagate after /ready starts serving.
            const { response, body } = yield* Effect.gen(function* () {
              const response = yield* method === "GET"
                ? client.get(url)
                : client.head(url);
              return { response, body: yield* response.text };
            }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                times: 8,
                until: ({ response }) =>
                  response.status !== 404 ||
                  response.headers["x-native"] !== undefined,
              }),
            );
            const mutated = path === "/status" || path === "/stream";
            const status =
              path === "/no-content"
                ? 204
                : path === "/reset-content"
                  ? 205
                  : path === "/not-modified"
                    ? 304
                    : path === "/explicit-status"
                      ? 201
                      : mutated
                        ? 418
                        : 202;
            expect(response.status).toBe(status);
            expect(response.headers["x-native"]).toBe(
              mutated
                ? "effect"
                : path === "/constructed-header"
                  ? "constructed"
                  : "native",
            );
            expect(response.headers["x-remove"]).toBe(
              mutated ? undefined : "native",
            );
            if (mutated) {
              expect(response.headers["x-observed-status"]).toBe("202");
              expect(response.headers["x-observed-native"]).toBe("native");
            }
            expect(Cookies.toRecord(response.cookies)).toEqual(
              path === "/cookie"
                ? { a: "1", b: "2", session: "abc" }
                : { a: "1", b: "2" },
            );
            expect(body).toBe(
              method === "HEAD" || [204, 205, 304].includes(status)
                ? ""
                : path === "/stream"
                  ? "raw-response:streamed"
                  : "raw-response:body",
            );
            const finalized = yield* client
              .get(
                `${worker.url!}/finalized?entry=${encodeURIComponent(`${method}:${path}`)}`,
              )
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                  until: (body) => body === "true",
                }),
              );
            expect({ request: `${method} ${path}`, finalized }).toEqual({
              request: `${method} ${path}`,
              finalized: "true",
            });
          }
        }

        yield* Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(
            `${worker.url!.replace(/^http/, "ws")}/websocket`,
          );
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write("response-upgrade");
          expect(yield* reader.pull).toEqual(["response-upgrade"]);
        }).pipe(
          Effect.scoped,
          Effect.provide(Socket.layerWebSocketConstructorGlobal),
        );
        yield* stack.destroy();
      }),
  );
}

describe("fromWeb responses use Effect status, headers and cookies", () => {
  it.effect("GET and HEAD agree on a pre-response status", () =>
    Effect.gen(function* () {
      const respond = () =>
        HttpServerResponse.fromWeb(new Response("onetwo", { status: 202 }));
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

  it.effect("preserves a status set before the handler returns", () =>
    Effect.gen(function* () {
      for (const method of ["GET", "HEAD"] as const) {
        const response = yield* handle(method, () =>
          HttpServerResponse.fromWeb(
            new Response("body", { status: 202 }),
          ).pipe(HttpServerResponse.setStatus(201)),
        );
        expect(response.status).toBe(201);
        expect(yield* Effect.promise(() => response.text())).toBe(
          method === "HEAD" ? "" : "body",
        );
      }
    }),
  );

  it.effect("a pre-response handler sees the native status and headers", () =>
    Effect.gen(function* () {
      const seen: Array<[number, string | undefined]> = [];
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.fromWeb(
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
      yield* Effect.promise(() => response.text());
    }),
  );

  it.effect("HEAD preserves native status and headers", () =>
    Effect.gen(function* () {
      const response = yield* handle("HEAD", () =>
        HttpServerResponse.fromWeb(
          new Response("body", { status: 202, headers: { "x-native": "yes" } }),
        ),
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("x-native")).toBe("yes");
      expect(response.body).toBeNull();
    }),
  );

  it.effect("keeps native cookies alongside Effect cookies", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.fromWeb(
            new Response("body", {
              headers: [
                ["set-cookie", "a=1"],
                ["set-cookie", "b=2"],
              ],
            }),
          ),
        (response) =>
          HttpServerResponse.setCookieUnsafe(response, "session", "abc"),
      );
      expect(response.headers.getSetCookie()).toEqual([
        "a=1",
        "b=2",
        "session=abc",
      ]);
      yield* Effect.promise(() => response.text());
    }),
  );

  it.effect("Effect headers override native headers", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.fromWeb(
            new Response("body", {
              headers: { "x-a": "native", "x-keep": "native" },
            }),
          ).pipe(HttpServerResponse.setHeader("x-a", "constructed")),
        (response) => HttpServerResponse.setHeader(response, "x-a", "later"),
      );
      expect(response.headers.get("x-a")).toBe("later");
      expect(response.headers.get("x-keep")).toBe("native");
      yield* Effect.promise(() => response.text());
    }),
  );

  it.effect("removes a native header through Effect", () =>
    Effect.gen(function* () {
      const response = yield* handle(
        "GET",
        () =>
          HttpServerResponse.fromWeb(
            new Response("body", { headers: { "x-a": "native" } }),
          ),
        (response) => HttpServerResponse.removeHeader(response, "x-a"),
      );
      expect(response.headers.has("x-a")).toBe(false);
      yield* Effect.promise(() => response.text());
    }),
  );

  for (const [method, status] of [
    ["GET", 200],
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
    ["GET", 304],
  ] as const) {
    it.effect(`closes the request scope for ${method} ${status}`, () =>
      Effect.gen(function* () {
        let finalized = false;
        const request = yield* Effect.sync(
          () => new Request("https://worker.test/scope", { method }),
        );
        const handled: Effect.Effect<Response> = makeRequestEffect<never>(
          request as any,
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized = true;
              }),
            );
            return yield* Effect.sync(() =>
              HttpServerResponse.fromWeb(new Response("body")).pipe(
                HttpServerResponse.setStatus(status),
              ),
            );
          }),
        );
        const response = yield* handled;
        const omitted = method === "HEAD" || status !== 200;
        if (omitted) {
          expect(response.body).toBeNull();
          expect(finalized).toBe(true);
        } else {
          expect(finalized).toBe(false);
          expect(yield* Effect.promise(() => response.text())).toBe("body");
          expect(finalized).toBe(true);
        }
      }),
    );
  }
});

describe("raw native response passthrough", () => {
  it.effect("keeps the native Response identity on GET", () =>
    Effect.gen(function* () {
      const native = yield* Effect.sync(
        () => new Response("body", { status: 202 }),
      );
      const response = yield* handle("GET", () =>
        HttpServerResponse.raw(native),
      );
      expect(response).toBe(native);
      expect(yield* Effect.promise(() => response.text())).toBe("body");
    }),
  );

  it.effect("keeps a 101 upgrade Response untouched", () =>
    Effect.gen(function* () {
      const native = yield* Effect.sync(
        () => new Response(null, { status: 101 }),
      );
      const response = yield* handle("GET", () =>
        HttpServerResponse.raw(native),
      );
      expect(response).toBe(native);
    }),
  );
});
