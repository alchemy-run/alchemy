import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as KV from "alchemy-effect/Cloudflare/KV";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Bucket } from "./Bucket.ts";
import PackageStore from "./PackageStore.ts";
import { TagIndex } from "./TagIndex.ts";

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

class Unauthorized {
  readonly _tag = "Unauthorized";
}

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    url: true,
    env: {
      AUTH_TOKEN: "test-bearer-token",
      DEFAULT_TTL_DAYS: "30",
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2BucketBinding.bind(Bucket);
    const kvGet = yield* KV.Get.bind(TagIndex);
    const kvPut = yield* KV.Put.bind(TagIndex);
    const kvDelete = yield* KV.Delete.bind(TagIndex);
    const packages = yield* PackageStore;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const path = url.pathname;
        const method = request.method;

        const env = yield* Cloudflare.WorkerEnvironment;
        const authToken = (env as any).AUTH_TOKEN as string;
        const defaultTtlDays = Number((env as any).DEFAULT_TTL_DAYS) || 30;

        const requireAuth = Effect.gen(function* () {
          const authHeader = request.headers.authorization;
          if (!authHeader || authHeader !== `Bearer ${authToken}`) {
            return yield* Effect.fail(new Unauthorized());
          }
        });

        // --- PUT /packages ---
        if (method === "PUT" && path === "/packages") {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const rawRequest =
              (yield* Cloudflare.Request) as globalThis.Request;
            const formData = yield* Effect.promise(() => rawRequest.formData());
            const file = formData.get("file") as unknown as File | null;
            const tagsRaw = formData.get("tags") as string | null;
            const ttlRaw = formData.get("ttl") as string | null;

            if (!file || !tagsRaw) {
              return yield* HttpServerResponse.json(
                { error: "file and tags are required" },
                { status: 400 },
              );
            }

            if (!file.name.endsWith(".tgz")) {
              return yield* HttpServerResponse.json(
                { error: "file must be a .tgz archive" },
                { status: 400 },
              );
            }

            const bytes = new Uint8Array(
              yield* Effect.promise(() => file.arrayBuffer()),
            );

            if (!isGzip(bytes)) {
              return yield* HttpServerResponse.json(
                { error: "file must be a valid .tgz (gzip) archive" },
                { status: 400 },
              );
            }

            let tags: string[];
            try {
              tags = JSON.parse(tagsRaw);
              if (!Array.isArray(tags) || tags.length === 0) {
                return yield* HttpServerResponse.json(
                  { error: "tags must be a non-empty JSON array of strings" },
                  { status: 400 },
                );
              }
            } catch {
              return yield* HttpServerResponse.json(
                { error: "tags must be valid JSON" },
                { status: 400 },
              );
            }

            const ttl = ttlRaw ? Number(ttlRaw) : defaultTtlDays;
            const resourceId = yield* Effect.promise(() =>
              sha256(bytes.buffer as ArrayBuffer),
            );
            const expiresAt = Date.now() + ttl * 24 * 60 * 60 * 1000;

            // reassign tags: remove from old resources, cleanup orphans
            for (const tag of tags) {
              const oldResourceId = yield* kvGet(`tag:${tag}`);
              if (oldResourceId && oldResourceId !== resourceId) {
                const oldStore = packages.getByName(oldResourceId);
                const { orphaned } = yield* oldStore
                  .removeTag(tag)
                  .pipe(Effect.orDie);
                if (orphaned) {
                  yield* r2
                    .delete(oldResourceId + ".tgz")
                    .pipe(Effect.orDie);
                  yield* kvDelete(`metadata:${oldResourceId}`);
                }
              }
            }

            // store blob
            yield* r2.put(resourceId + ".tgz", bytes).pipe(Effect.orDie);

            // store tag pointers in KV
            for (const tag of tags) {
              yield* kvPut(`tag:${tag}`, resourceId);
            }

            // store metadata in KV (for potential cron cleanup)
            yield* kvPut(
              `metadata:${resourceId}`,
              JSON.stringify({ tags, expiresAt }),
            );

            // init DO state
            const store = packages.getByName(resourceId);
            yield* store.init(tags, expiresAt).pipe(Effect.orDie);

            return yield* HttpServerResponse.json({
              resourceId,
              tags,
              ttl,
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

        // --- GET /tags/:tag ---
        if (method === "GET" && path.startsWith("/tags/")) {
          const tag = decodeURIComponent(path.slice("/tags/".length));
          const resourceId = yield* kvGet(`tag:${tag}`);
          if (!resourceId) {
            return yield* HttpServerResponse.json(
              { error: "tag not found" },
              { status: 404 },
            );
          }

          const object = yield* r2
            .get(resourceId + ".tgz")
            .pipe(Effect.orDie);
          if (!object) {
            yield* kvDelete(`tag:${tag}`);
            return yield* HttpServerResponse.json(
              { error: "resource not found" },
              { status: 404 },
            );
          }

          // record download
          const store = packages.getByName(resourceId);
          yield* store.recordDownload(tag).pipe(Effect.orDie);

          const body = yield* object.arrayBuffer().pipe(Effect.orDie);
          return HttpServerResponse.fromWeb(
            new Response(body, {
              status: 200,
              headers: { "content-type": "application/gzip" },
            }),
          );
        }

        // --- DELETE /tags/:tag ---
        if (method === "DELETE" && path.startsWith("/tags/")) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tag = decodeURIComponent(path.slice("/tags/".length));
            const resourceId = yield* kvGet(`tag:${tag}`);
            if (!resourceId) {
              return yield* HttpServerResponse.json(
                { error: "tag not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(resourceId);
            const { orphaned } = yield* store
              .removeTag(tag)
              .pipe(Effect.orDie);

            yield* kvDelete(`tag:${tag}`);

            if (orphaned) {
              yield* r2
                .delete(resourceId + ".tgz")
                .pipe(Effect.orDie);
              yield* kvDelete(`metadata:${resourceId}`);
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

        // --- GET /packages/:resourceId/stats ---
        if (
          method === "GET" &&
          path.startsWith("/packages/") &&
          path.endsWith("/stats")
        ) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const resourceId = path.slice(
              "/packages/".length,
              -"/stats".length,
            );
            const meta = yield* kvGet(`metadata:${resourceId}`);
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
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        KV.GetLive,
        KV.PutLive,
        KV.DeleteLive,
      ),
    ),
  ),
) {}
