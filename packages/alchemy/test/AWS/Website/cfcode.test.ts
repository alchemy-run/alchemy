/**
 * Unit coverage of the generated viewer-request CloudFront Function code —
 * `routeSite` from `cfcode.ts` executed in-process against a stubbed
 * `cloudfront` runtime — pinning the `serverRoutes` dispatch (DESIGN §4.2):
 * matched prefixes route to the server origin BEFORE the manifest lookup
 * (a static file can never shadow an API path, even under `spa`), and
 * `serverRoutesOnly` keeps manifest misses on the static fallback instead
 * of the server.
 */
import { CF_ROUTER_INJECTION } from "@/AWS/Website/cfcode.ts";
import { compileServerRoutes } from "@/AWS/Website/Effectful.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

interface RouteResult {
  /** A terminal response returned by the function (redirect/431), if any. */
  response: unknown;
  /** The (possibly rewritten) request URI after routing. */
  uri: string;
  /** Origins passed to `cf.updateRequestOrigin`, in order. */
  origins: Array<{ domainName: string; [key: string]: unknown }>;
  /** Request headers after routing. */
  headers: Record<string, { value: string }>;
}

/**
 * Execute the injected `routeSite` against a stubbed `cf` module and a
 * synthetic viewer-request event. `files` is the uploaded-manifest key set
 * (`/path` form); missing keys reject like a real KVS miss.
 */
const routeSite = (options: {
  metadata: Record<string, unknown>;
  uri: string;
  files?: string[];
}): Effect.Effect<RouteResult> =>
  Effect.promise(async () => {
    const origins: RouteResult["origins"] = [];
    const files = new Set(options.files ?? []);
    const cf = {
      kvs: () => ({
        get: (key: string) => {
          const path = key.slice("test:".length);
          return files.has(path)
            ? Promise.resolve("s3")
            : Promise.reject(new Error(`KeyNotFound: ${key}`));
        },
      }),
      updateRequestOrigin: (origin: RouteResult["origins"][number]) => {
        origins.push(origin);
      },
    };
    const event = {
      request: {
        uri: options.uri,
        headers: { host: { value: "site.example.com" } } as Record<
          string,
          { value: string }
        >,
        querystring: {} as Record<string, { value: string }>,
        cookies: {} as Record<string, { value: string }>,
      },
    };
    // The injection is plain function declarations closing over `event` and
    // `cf` — exactly how the generated handler embeds it (module-level
    // `import cf from "cloudfront"`, `event` as the handler parameter).
    const run = new Function(
      "event",
      "cf",
      "metadata",
      `${CF_ROUTER_INJECTION}\nreturn routeSite("test", metadata);`,
    ) as (event: unknown, cf: unknown, metadata: unknown) => Promise<unknown>;
    const response = await run(event, cf, options.metadata);
    return {
      response,
      uri: event.request.uri,
      origins,
      headers: event.request.headers,
    };
  });

const SERVER_HOST = "abc123.lambda-url.us-east-1.on.aws";
const S3_DOMAIN = "assets.s3.us-east-1.amazonaws.com";

/** Metadata of an effectful StaticSite: spa + serverRoutesOnly. */
const effectfulMetadata = (overrides?: Record<string, unknown>) => ({
  custom404: "/index.html",
  s3: { domain: S3_DOMAIN, dir: "", routes: [] },
  servers: [[SERVER_HOST]],
  serverRoutes: { include: ["^/api/.*$"], exclude: [] },
  serverRoutesOnly: true,
  ...overrides,
});

/** Metadata of a framework SSR site: server fallback, no route scoping. */
const frameworkMetadata = () => ({
  s3: { domain: S3_DOMAIN, dir: "", routes: [] },
  servers: [[SERVER_HOST]],
});

describe("AWS.Website cfcode serverRoutes", () => {
  it.effect(
    "a serverRoutes match routes to the server origin even when a static file shadows the path",
    () =>
      Effect.gen(function* () {
        const result = yield* routeSite({
          metadata: effectfulMetadata(),
          uri: "/api/data",
          // The manifest CONTAINS /api/data — the server check must win
          // anyway (runs before the manifest lookup).
          files: ["/api/data", "/index.html"],
        });
        expect(result.response).toBeUndefined();
        expect(result.origins).toHaveLength(1);
        expect(result.origins[0]!.domainName).toBe(SERVER_HOST);
        // The URI is forwarded unrewritten and x-forwarded-host is set.
        expect(result.uri).toBe("/api/data");
        expect(result.headers["x-forwarded-host"]!.value).toBe(
          "site.example.com",
        );
      }),
  );

  it.effect(
    "spa fallback still serves the index for misses outside serverRoutes",
    () =>
      Effect.gen(function* () {
        const result = yield* routeSite({
          metadata: effectfulMetadata(),
          uri: "/missing/client/route",
          files: ["/index.html"],
        });
        expect(result.response).toBeUndefined();
        // custom404 rewrite to the app shell, served from S3 — never the
        // server (serverRoutesOnly).
        expect(result.uri).toBe("/index.html");
        expect(result.origins).toHaveLength(1);
        expect(result.origins[0]!.domainName).toBe(S3_DOMAIN);
      }),
  );

  it.effect("a manifest hit outside serverRoutes serves from S3", () =>
    Effect.gen(function* () {
      const result = yield* routeSite({
        metadata: effectfulMetadata(),
        uri: "/styles.css",
        files: ["/styles.css", "/index.html"],
      });
      expect(result.uri).toBe("/styles.css");
      expect(result.origins[0]!.domainName).toBe(S3_DOMAIN);
    }),
  );

  it.effect(
    "an exclusion glob carves a path out of the server's URL space",
    () =>
      Effect.gen(function* () {
        const metadata = effectfulMetadata({
          serverRoutes: {
            include: ["^/api/.*$"],
            exclude: ["^/api/public/.*$"],
          },
        });
        const excluded = yield* routeSite({
          metadata,
          uri: "/api/public/logo.svg",
          files: ["/api/public/logo.svg"],
        });
        expect(excluded.origins[0]!.domainName).toBe(S3_DOMAIN);
        const included = yield* routeSite({
          metadata,
          uri: "/api/users",
          files: [],
        });
        expect(included.origins[0]!.domainName).toBe(SERVER_HOST);
      }),
  );

  it.effect(
    "a framework site without serverRoutes keeps forwarding misses to the server",
    () =>
      Effect.gen(function* () {
        const result = yield* routeSite({
          metadata: frameworkMetadata(),
          uri: "/ssr/page",
          files: ["/favicon.ico"],
        });
        // Regression pin for the pre-existing SSR behavior: no serverRoutes
        // stamped, so the miss falls through to the server origin.
        expect(result.origins).toHaveLength(1);
        expect(result.origins[0]!.domainName).toBe(SERVER_HOST);
      }),
  );

  it.effect(
    "serverRoutesOnly without spa falls back to the index page, not the server",
    () =>
      Effect.gen(function* () {
        const result = yield* routeSite({
          metadata: effectfulMetadata(),
          uri: "/definitely/not/here",
          files: [],
        });
        // custom404 rewrite; the server is never consulted for misses.
        expect(result.uri).toBe("/index.html");
        expect(result.origins[0]!.domainName).toBe(S3_DOMAIN);
      }),
  );
});

describe("AWS.Website compileServerRoutes", () => {
  it.effect(
    "compiles the runWorkerFirst glob dialect into anchored regex sources",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compileServerRoutes("Site", [
          "/api/*",
          "!/api/public/*",
        ]);
        expect(compiled.include).toEqual(["^/api/.*$"]);
        expect(compiled.exclude).toEqual(["^/api/public/.*$"]);
        // `*` spans `/` (the runWorkerFirst dialect); regex metacharacters in
        // literals are escaped.
        expect(new RegExp(compiled.include[0]!).test("/api/a/b/c")).toBe(true);
        expect(new RegExp(compiled.include[0]!).test("/apix")).toBe(false);
        const dotted = yield* compileServerRoutes("Site", ["/v1.0/*"]);
        expect(new RegExp(dotted.include[0]!).test("/v1.0/x")).toBe(true);
        expect(new RegExp(dotted.include[0]!).test("/v1x0/x")).toBe(false);
      }),
  );

  it.effect(
    "rejects globs that are not path-shaped and empty route lists",
    () =>
      Effect.gen(function* () {
        const invalid = yield* compileServerRoutes("Site", ["api/*"]).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) {
          expect(String(Cause.squash(invalid.cause))).toContain(
            "invalid server.routes glob",
          );
        }
        const empty = yield* compileServerRoutes("Site", []).pipe(Effect.exit);
        expect(Exit.isFailure(empty)).toBe(true);
      }),
  );
});

describe("AWS.Website CloudFront Function size limit", () => {
  // CloudFront Functions hard-cap code at 10 KB. The shared Router's
  // request function silently crossed it when the serverRoutes edge block
  // landed (surfaced live as FunctionSizeLimitExceeded only after weeks of
  // masked runs), so the WORST-CASE composition — host redirect with
  // redirect hosts AND the cloudfront-default arm, plus a typical user
  // injection — is pinned here with headroom for growth.
  it("the Router request function stays under 10KB in its worst-case shape", async () => {
    const { buildRouterRequestFunctionCode } =
      await import("@/AWS/Website/Router.ts");
    const code = buildRouterRequestFunctionCode({
      kvNamespace: "alchemy-router-namespace-with-a-long-name",
      userInjection:
        'if (event.request.uri === "/health") { return { statusCode: 200, statusDescription: "OK" }; }',
      hostRedirect: {
        to: "app.example.com",
        hosts: ["www.example.com", "example.com"],
        cloudfrontDefault: true,
      },
    });
    const bytes = Buffer.byteLength(code);
    expect(bytes).toBeLessThan(10_240);
    // Growth headroom: fail the build well before the cliff.
    expect(bytes).toBeLessThan(9_728);
  });
});
