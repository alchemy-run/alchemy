import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * Serve a built SPA from the directory named by
 * `ALCHEMY_SERVICE_ASSETS`, ASSET-FIRST, around the program's own
 * `fetch` handler — the {@link Service} `vite` prop's runtime half:
 *
 * - a GET/HEAD whose path is an existing file under the assets dir is
 *   served from disk (per-request reads: a rebuild lands without a
 *   process restart);
 * - everything else runs the program's handler;
 * - a handler 404 for an HTML-accepting GET falls back to
 *   `index.html` — client-side routes deep-link correctly while API
 *   404s (JSON accepts) stay 404s.
 *
 * Without the env var this is a pass-through — the wrapper costs
 * nothing on hosts that ship no assets.
 */
export const withStaticAssets = (handler: HttpEffect<any>): HttpEffect<any> =>
  Effect.gen(function* () {
    const dir = process.env.ALCHEMY_SERVICE_ASSETS;
    if (!dir) return yield* handler;

    const request = yield* HttpServerRequest;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return yield* handler;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const pathname = decodeURIComponent(request.url.split("?")[0] ?? "/");
    const serveFile = (relative: string) =>
      Effect.gen(function* () {
        const candidate = path.normalize(path.join(dir, relative));
        if (!candidate.startsWith(path.normalize(dir))) return undefined;
        const info = yield* fs
          .stat(candidate)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (info?.type !== "File") return undefined;
        const bytes = yield* fs
          .readFile(candidate)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (bytes === undefined) return undefined;
        const extension = path.extname(candidate).toLowerCase();
        return HttpServerResponse.uint8Array(bytes, {
          headers: {
            "content-type": MIME[extension] ?? "application/octet-stream",
            // hashed bundle files are immutable; the html shell is not
            "cache-control":
              extension === ".html"
                ? "no-cache"
                : "public, max-age=31536000, immutable",
          },
        });
      });

    const asset = yield* serveFile(pathname === "/" ? "index.html" : pathname);
    if (asset !== undefined) return asset;

    const response = yield* handler;
    if (
      response.status === 404 &&
      request.method === "GET" &&
      (request.headers.accept ?? "").includes("text/html")
    ) {
      const index = yield* serveFile("index.html");
      if (index !== undefined) return index;
    }
    return response;
  });
