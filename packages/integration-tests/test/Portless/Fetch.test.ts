import * as Portless from "@alchemy.run/portless";
import { resolveAgainst } from "@alchemy.run/portless/internal/Resolve";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";

describe("a relative URL", () => {
  const urlOf = (url: string, origin = "https://dev-alice.api.myapp.localhost") =>
    resolveAgainst(HttpClientRequest.get(url), origin).url;

  it("resolves against the service's origin", () => {
    expect(urlOf("/health")).toBe("https://dev-alice.api.myapp.localhost/health");
    expect(urlOf("health")).toBe("https://dev-alice.api.myapp.localhost/health");
    expect(urlOf("/a/b?c=d")).toBe("https://dev-alice.api.myapp.localhost/a/b?c=d");
    expect(urlOf("/health", "https://dev-alice.api.myapp.localhost:8443")).toBe(
      "https://dev-alice.api.myapp.localhost:8443/health",
    );
    // With PORTLESS=0 the origin is plain http on localhost.
    expect(urlOf("/health", "http://localhost:5173")).toBe("http://localhost:5173/health");
  });

  it("leaves an absolute URL alone", () => {
    expect(urlOf("https://example.com/x")).toBe("https://example.com/x");
  });

  it("keeps the request's method and query parameters", () => {
    const request = HttpClientRequest.post("/items").pipe(
      HttpClientRequest.setUrlParam("page", "2"),
    );
    const resolved = resolveAgainst(request, "https://dev-alice.api.myapp.localhost");
    expect(resolved.method).toBe("POST");
    expect(resolved.url).toBe("https://dev-alice.api.myapp.localhost/items");
    expect(resolved.urlParams).toEqual(request.urlParams);
  });
});

// A plain `alchemy deploy` run: the resource is a no-op placeholder and nothing is dev.
const { test } = Test.make({ providers: Portless.providers() });

test.provider(
  "binding Portless.Fetch outside alchemy dev fails with a typed error that says Portless is dev-only",
  (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const proxy = yield* Portless.Proxy("Proxy", { domain: "fetch-deploy" });
            const api = yield* Portless.Dev("Api", { proxy, command: "node server.mjs" });
            return yield* Portless.Fetch(api).pipe(
              Effect.provide(Portless.FetchHttp),
              Effect.provide(FetchHttpClient.layer),
            );
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(defect).toBeInstanceOf(Portless.FetchDevOnly);
      expect((defect as Portless.FetchDevOnly).service).toBe("Api");
      expect((defect as Error).message).toContain("Portless is dev-only");
    }),
);
