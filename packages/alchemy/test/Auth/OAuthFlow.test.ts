import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";
import { makeOAuthClient } from "@/Auth/OAuthFlow.ts";

describe("OAuthFlow tracing redaction", { tags: ["unit"] }, () => {
  // Regression: the CLI wraps every command in an OTLP tracer, and Effect's
  // HttpClient records each request's URL as span attributes. PlanetScale's
  // OAuth client uses the `query` token transport, so a plain-string
  // `refresh_token`/`client_secret` would be exported to otel.alchemy.run in
  // `url.full`/`url.query`. The params must stay `Redacted` so the tracer
  // masks them while still sending the real value on the wire.
  const runRefresh = (transport: "query" | "body") =>
    Effect.gen(function* () {
      const REFRESH = "USER-REFRESH-TOKEN-SECRET";
      const SECRET = "CLIENT-SECRET-VALUE";
      let wireUrl = "";

      // SAFETY: the test double implements the callable fetch contract; Bun's
      // nonstandard static `preconnect` member is not used by FetchHttpClient.
      const fetch = (async (input: string | URL | Request) => {
        wireUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return new Response(
          JSON.stringify({ access_token: "a", refresh_token: "new-refresh", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof globalThis.fetch;

      const client = makeOAuthClient({
        clientId: "client-id",
        endpoints: { token: "https://auth.example.com/oauth/token" },
        auth: { kind: "clientSecret", clientSecret: Redacted.make(SECRET) },
        tokenTransport: transport,
      });

      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      yield* client
        .refresh({
          type: "oauth",
          clientId: "client-id",
          access: Redacted.make("old-access"),
          refresh: Redacted.make(REFRESH),
          expires: 0,
          scopes: [],
        })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(Tracer.Tracer, tracer),
        );

      return { spans, wireUrl, REFRESH, SECRET };
    });

  it("masks refresh_token and client_secret in spans (query transport)", async () => {
    const { spans, wireUrl, REFRESH, SECRET } = await Effect.runPromise(runRefresh("query"));

    // The real token is sent unwrapped on the wire…
    expect(wireUrl).toContain(`refresh_token=${REFRESH}`);

    // …but every HTTP span records it masked.
    const httpSpan = spans.find((s) => s.attributes.has("url.full"));
    expect(httpSpan).toBeDefined();
    const urlFull = String(httpSpan!.attributes.get("url.full"));
    const urlQuery = String(httpSpan!.attributes.get("url.query") ?? "");
    expect(urlFull).not.toContain(REFRESH);
    expect(urlFull).not.toContain(SECRET);
    expect(urlFull).toContain("REDACTED");
    expect(urlQuery).not.toContain(REFRESH);
    expect(urlQuery).not.toContain(SECRET);
  });

  it("keeps secrets out of the URL entirely on the body transport", async () => {
    const { spans, REFRESH, SECRET } = await Effect.runPromise(runRefresh("body"));
    const httpSpan = spans.find((s) => s.attributes.has("url.full"));
    expect(httpSpan).toBeDefined();
    const urlFull = String(httpSpan!.attributes.get("url.full"));
    expect(urlFull).not.toContain(REFRESH);
    expect(urlFull).not.toContain(SECRET);
  });
});
