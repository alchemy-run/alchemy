import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { createHostRuntimeContext } from "@/Runtime/Process";
import { RuntimeContext } from "@/RuntimeContext";
import * as Sandbox from "@/Sandbox";

// What a provider writes: send a client request to the port and return the
// response. This one echoes what reached the port.
const echoPort = Sandbox.portFetch<never>((request) =>
  Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
    const body = yield* Effect.promise(() => web.text());
    const url = new URL(web.url);
    return HttpClientResponse.fromWeb(
      request,
      new Response(`${web.method} ${url.pathname}${url.search} ${body}`, {
        status: 201,
        headers: { "x-port": "3000", "content-type": "text/plain" },
      }),
    );
  }),
);

// The port calls run where a deployed runtime would, so the tests give them one.
const inRuntime = Effect.provideService(
  RuntimeContext,
  createHostRuntimeContext("Test.Host")("Proxy"),
);

describe("Sandbox.portFetch", { tags: ["unit"] }, () => {
  it.effect("a client request reaches the port and returns a client response", () =>
    Effect.gen(function* () {
      const response = yield* echoPort(
        HttpClientRequest.post("http://sandbox/run?x=1").pipe(HttpClientRequest.bodyText("hi")),
      );
      expect(response.status).toBe(201);
      expect(yield* response.text).toBe("POST /run?x=1 hi");
    }).pipe(inRuntime),
  );

  it.effect("a server request is proxied and returns a server response", () =>
    Effect.gen(function* () {
      const incoming = HttpServerRequest.fromWeb(
        new Request("https://worker.example/run?x=1", { method: "PUT", body: "hello" }),
      );
      const response = yield* echoPort(incoming);
      expect(response.status).toBe(201);
      expect(response.headers["x-port"]).toBe("3000");
      const web = HttpServerResponse.toWeb(response);
      expect(yield* Effect.promise(() => web.text())).toBe("PUT /run?x=1 hello");
    }).pipe(inRuntime),
  );
});
