import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { aliasRedirectUrl, parseAlias } from "./aliases.ts";
import { AuthToken } from "./AuthToken.ts";
import { Bucket } from "./Bucket.ts";
import PackageStore from "./PackageStore.ts";
import { TagIndex } from "./TagIndex.ts";

class Unauthorized {
  readonly _tag = "Unauthorized";
}

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Stack.useSync(({ stage }) => ({
    main: import.meta.path,
    url: true,
    env: {
      DEFAULT_TTL: "3 weeks",
    },
    domain:
      stage === "prod"
        ? [
            "pkg.ing",
            "pkg.alchemy.run",
            "📦.alchemy.run",
            "pkg.distilled.cloud",
            "📦.distilled.cloud",
          ]
        : undefined,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  })),
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2Bucket.bind(Bucket);
    const kv = yield* Cloudflare.KVNamespace.bind(TagIndex);
    const authToken = yield* Cloudflare.Secret.bind(AuthToken);
    const packages = yield* PackageStore;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const path = url.pathname;
        const method = request.method;

        const env = yield* Cloudflare.WorkerEnvironment;
        const defaultTtl = ((env as any).DEFAULT_TTL as string) || "3 weeks";

        const requireAuth = Effect.gen(function* () {
          const authHeader = request.headers.authorization;
          const expected = yield* authToken;
          if (!authHeader || authHeader !== `Bearer ${expected}`) {
            return yield* Effect.fail(new Unauthorized());
          }
        });

        // Pretty alias paths (e.g. /alchemy/<tag>, /@alchemy.run/<name>/<tag>)
        // 301 to the canonical /projects/:project/tags/:tag URL.
        if (method === "GET" && !path.startsWith("/projects/")) {
          const aliasMatch = parseAlias(request.headers.host, path);
          if (aliasMatch) {
            return HttpServerResponse.fromWeb(
              new Response(null, {
                status: 301,
                headers: { location: aliasRedirectUrl(aliasMatch) },
              }),
            );
          }
        }

        // Route pattern: /projects/:project/...
        // :project may be scoped (@scope/name) or unscoped (name) — matches
        // npm package naming. Accept literal `@` or its percent-encoded form
        // `%40` since strict HTTP clients (e.g. bun) encode `@` in paths.
        const projectMatch = path.match(
          /^\/projects\/((?:@|%40)[^/]+\/[^/]+|[^/]+)(\/.*)?$/i,
        );
        if (!projectMatch) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const project = decodeURIComponent(projectMatch[1]);
        const subPath = projectMatch[2] || "/";

        // --- PUT /projects/:project/packages ---
        // Body: raw .tgz stream (streamed directly to R2)
        // Headers: X-Tags (JSON array), X-TTL (optional, Effect Duration string e.g. "7 hours", "3 weeks"), Content-Length
        if (method === "PUT" && subPath === "/packages") {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tagsRaw = request.headers["x-tags"];
            const ttlRaw = request.headers["x-ttl"];
            const contentLength = Number(
              request.headers["content-length"] ?? 0,
            );

            if (!tagsRaw) {
              return yield* HttpServerResponse.json(
                { error: "X-Tags header is required" },
                { status: 400 },
              );
            }

            let tags: string[];
            try {
              tags = JSON.parse(tagsRaw);
              if (!Array.isArray(tags) || tags.length === 0) {
                return yield* HttpServerResponse.json(
                  { error: "X-Tags must be a non-empty JSON array of strings" },
                  { status: 400 },
                );
              }
            } catch {
              return yield* HttpServerResponse.json(
                { error: "X-Tags must be valid JSON" },
                { status: 400 },
              );
            }

            if (!contentLength) {
              return yield* HttpServerResponse.json(
                { error: "Content-Length header is required" },
                { status: 400 },
              );
            }

            const ttlStr = ttlRaw || defaultTtl;
            const ttlDuration = Duration.fromInput(ttlStr as Duration.Input);
            if (ttlDuration._tag === "None") {
              return yield* HttpServerResponse.json(
                {
                  error:
                    "X-TTL must be an Effect Duration string (e.g. '7 hours', '3 weeks', '30 minutes')",
                },
                { status: 400 },
              );
            }
            const ttlMillis = Duration.toMillis(ttlDuration.value);
            if (ttlMillis <= 0) {
              return yield* HttpServerResponse.json(
                {
                  error:
                    "X-TTL must be a positive duration (e.g. '7 hours', '3 weeks')",
                },
                { status: 400 },
              );
            }
            const resourceId = crypto.randomUUID();
            const expiresAt = Date.now() + ttlMillis;

            // reassign tags: remove from old resources, cleanup orphans
            for (const tag of tags) {
              const oldResourceId = yield* kv.get(`tag:${project}:${tag}`);
              if (oldResourceId && oldResourceId !== resourceId) {
                const oldStore = packages.getByName(oldResourceId);
                const { orphaned } = yield* oldStore
                  .removeTag(tag)
                  .pipe(Effect.orDie);
                if (orphaned) {
                  yield* r2.delete(oldResourceId + ".tgz").pipe(Effect.orDie);
                  yield* kv.delete(`metadata:${oldResourceId}`);
                }
              }
            }

            // Stream body directly to R2 via FixedLengthStream (no buffering).
            // Uses request.stream from Effect's HttpServerRequest which
            // provides the raw body as a ReadableStream.
            yield* r2
              .put(resourceId + ".tgz", request.stream, {
                contentLength,
              })
              .pipe(Effect.orDie);

            // store tag pointers in KV (scoped by project)
            for (const tag of tags) {
              yield* kv.put(`tag:${project}:${tag}`, resourceId);
            }

            // store metadata in KV (for potential cron cleanup)
            yield* kv.put(
              `metadata:${resourceId}`,
              JSON.stringify({ project, tags, expiresAt }),
            );

            // init DO state
            const store = packages.getByName(resourceId);
            yield* store.init(tags, expiresAt).pipe(Effect.orDie);

            return yield* HttpServerResponse.json({
              resourceId,
              project,
              tags,
              ttl: ttlStr,
              expiresAt,
            });
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        // --- GET /projects/:project/tags/:tag --- (302 redirect to /projects/:project/packages/:resourceId)
        if (method === "GET" && subPath.startsWith("/tags/")) {
          const tag = decodeURIComponent(subPath.slice("/tags/".length));
          const resourceId = yield* kv.get(`tag:${project}:${tag}`);
          if (!resourceId) {
            return yield* HttpServerResponse.json(
              { error: "tag not found" },
              { status: 404 },
            );
          }

          // record download (before redirect so we know which tag was used)
          const store = packages.getByName(resourceId);
          yield* store.recordDownload(tag).pipe(Effect.orDie);

          // Encode each path segment but keep `/` literal so scoped projects
          // round-trip through the route regex (which splits scope/name on
          // a literal slash).
          const encodedProject = project
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          return HttpServerResponse.fromWeb(
            new Response(null, {
              status: 302,
              headers: {
                location: `/projects/${encodedProject}/packages/${resourceId}`,
              },
            }),
          );
        }

        // --- GET /projects/:project/packages/:resourceId --- (serve blob, cacheable)
        if (
          method === "GET" &&
          subPath.startsWith("/packages/") &&
          !subPath.endsWith("/stats")
        ) {
          const resourceId = subPath.slice("/packages/".length);
          const object = yield* r2.get(resourceId + ".tgz").pipe(Effect.orDie);
          if (!object) {
            return yield* HttpServerResponse.json(
              { error: "resource not found" },
              { status: 404 },
            );
          }

          const body = yield* object.arrayBuffer().pipe(Effect.orDie);
          return HttpServerResponse.fromWeb(
            new Response(body, {
              status: 200,
              headers: {
                "content-type": "application/gzip",
                "cache-control": "public, max-age=31536000, immutable",
              },
            }),
          );
        }

        // --- DELETE /projects/:project/tags/:tag ---
        if (method === "DELETE" && subPath.startsWith("/tags/")) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tag = decodeURIComponent(subPath.slice("/tags/".length));
            const resourceId = yield* kv.get(`tag:${project}:${tag}`);
            if (!resourceId) {
              return yield* HttpServerResponse.json(
                { error: "tag not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(resourceId);
            const { orphaned } = yield* store.removeTag(tag).pipe(Effect.orDie);

            yield* kv.delete(`tag:${project}:${tag}`);

            if (orphaned) {
              yield* r2.delete(resourceId + ".tgz").pipe(Effect.orDie);
              yield* kv.delete(`metadata:${resourceId}`);
            }

            return yield* HttpServerResponse.json({ ok: true });
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        // --- GET /projects/:project/packages/:resourceId/stats ---
        if (
          method === "GET" &&
          subPath.startsWith("/packages/") &&
          subPath.endsWith("/stats")
        ) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const resourceId = subPath.slice(
              "/packages/".length,
              -"/stats".length,
            );
            const meta = yield* kv.get(`metadata:${resourceId}`);
            if (!meta) {
              return yield* HttpServerResponse.json(
                { error: "resource not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(resourceId);
            const stats = yield* store.getStats().pipe(Effect.orDie);

            return yield* HttpServerResponse.json(stats);
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((error: any) =>
          Effect.succeed(
            HttpServerResponse.text(
              `Internal Server Error: ${error?.message ?? error?._tag ?? String(error)}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.KVNamespaceBindingLive,
        Cloudflare.SecretBindingLive,
      ),
    ),
  ),
) {}
