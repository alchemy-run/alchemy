/**
 * Shared Node HTTP serve-entry generator for container deploy targets.
 *
 * The finishing pass of each SSR node target writes one of these files and
 * pins it as `serverModules[0]`. The program is a complete bun/node entry
 * (`isExternal: true` on the platform Service): it listens on `PORT`
 * (default 3000), answers `GET /health`, serves `clientDirectory` on GET
 * first, then falls through to the framework fetch/Node handler.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import {
  toOutputFile,
  type BuildOutput,
  type OutputFile,
} from "./BuildOutput.ts";
import { DeployTargetError } from "./DeployTarget.ts";

/** Node resolve conditions for server code (no `workerd`). */
export const NODE_BUNDLE_CONDITIONS = [
  "node",
  "import",
  "module",
  "default",
] as const;

/** The file name the finishing pass writes next to the framework server entry. */
export const NODE_SERVE_ENTRY_FILE_NAME = "serve-node.mjs";

/** Default listen port (Hetzner `deployUnit` curls `/health` whenever `PORT` is set). */
export const NODE_DEFAULT_PORT = 3000;

export type NodeServeHtmlHandling = "none" | "drop-trailing-slash";
export type NodeServeNotFoundHandling = "none" | "spa" | "404-page";
export type NodeServeHandlerKind = "fetch" | "node";

export interface NodeServeHandler {
  /** `"fetch"` is `(request) => Response`; `"node"` is `(req, res) => void`. */
  readonly kind: NodeServeHandlerKind;
  /** ESM import statements for the handler module. */
  readonly imports: string;
  /** Expression that evaluates to the fetch handler or Node listener. */
  readonly expr: string;
}

export interface NodeServeEntryOptions {
  /**
   * JS expression resolving the on-disk client-assets directory
   * (typically `fileURLToPath(new URL("../client/", import.meta.url))`).
   * Omit to skip static-file serving (Next.js handles its own assets).
   */
  readonly clientDirExpression?: string | undefined;
  readonly handler: NodeServeHandler;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about` (CF
   * `htmlHandling: "drop-trailing-slash"`).
   * @default "none"
   */
  readonly htmlHandling?: NodeServeHtmlHandling | undefined;
  /**
   * Fallback when no static file matches: `"spa"` serves `index.html`,
   * `"404-page"` serves `404.html` with status 404. Handler still runs
   * when the fallback file is missing.
   * @default "none"
   */
  readonly notFoundHandling?: NodeServeNotFoundHandling | undefined;
  /** @default 3000 */
  readonly defaultPort?: number | undefined;
}

/**
 * JS expression that resolves `clientDirectory` relative to a serve-entry
 * file via `import.meta.url`. Falls back to an absolute JSON string when
 * the two paths do not share a relative root (e.g. different Windows drives).
 */
export const relativeClientDirExpression = (
  fromFile: string,
  clientDirectory: string,
): string => {
  const fromDir = NodePath.posix.dirname(fromFile.replaceAll("\\", "/"));
  const client = clientDirectory.replaceAll("\\", "/");
  let relative = NodePath.posix.relative(fromDir, client);
  if (relative === "") {
    relative = ".";
  }
  if (NodePath.posix.isAbsolute(relative)) {
    return JSON.stringify(clientDirectory);
  }
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  if (!relative.endsWith("/")) {
    relative = `${relative}/`;
  }
  return `fileURLToPath(new URL(${JSON.stringify(relative)}, import.meta.url))`;
};

/** Pin `serveModule` as `serverModules[0]`, keeping the rest of the bundle. */
export const pinNodeServeModule = (
  output: BuildOutput,
  serveModule: OutputFile,
): BuildOutput => ({
  ...output,
  serverModules: [
    serveModule,
    ...(output.serverModules ?? []).filter(
      (module_) => module_.name !== serveModule.name,
    ),
  ],
});

/**
 * Generate a complete Node/Bun HTTP program: `/health`, GET static assets,
 * then the framework handler. No package imports other than `node:*` and
 * the handler module the caller passes in.
 */
export const makeNodeServeEntrySource = (
  options: NodeServeEntryOptions,
): string => {
  const port = options.defaultPort ?? NODE_DEFAULT_PORT;
  const htmlHandling = options.htmlHandling ?? "none";
  const notFoundHandling = options.notFoundHandling ?? "none";
  const hasStatic = options.clientDirExpression !== undefined;
  const dropSlash = htmlHandling === "drop-trailing-slash";
  const spa = notFoundHandling === "spa";
  const notFoundPage = notFoundHandling === "404-page";
  const handlerIsFetch = options.handler.kind === "fetch";

  const staticBlock = hasStatic
    ? `
const CLIENT_DIR = ${options.clientDirExpression};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const existingFile = (filePath) => {
  try {
    const st = fs.statSync(filePath);
    if (st.isFile()) return filePath;
    if (st.isDirectory()) {
      const index = path.join(filePath, "index.html");
      try {
        if (fs.statSync(index).isFile()) return index;
      } catch {}
    }
  } catch {}
  return undefined;
};

const safeJoin = (urlPath) => {
  const relative = urlPath.replace(/^\\/+/, "");
  const resolved = path.resolve(CLIENT_DIR, relative);
  const root = path.resolve(CLIENT_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return undefined;
  }
  return resolved;
};

const lookupStatic = (urlPath) => {
  const base = safeJoin(urlPath);
  if (base === undefined) return undefined;
  const direct = existingFile(base);
  if (direct) return direct;
${
  dropSlash
    ? `  if (!path.extname(base)) {
    const html = existingFile(base + ".html");
    if (html) return html;
  }
`
    : ""
}  return undefined;
};

const sendFile = (res, filePath, status) => {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(status, {
    "content-type": MIME[ext] ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
};
`
    : "";

  const staticDispatch = hasStatic
    ? `
    if (req.method === "GET" || req.method === "HEAD") {
      const file = lookupStatic(urlPath);
      if (file !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(200);
          res.end();
          return;
        }
        sendFile(res, file, 200);
        return;
      }
${
  spa
    ? `      const spaIndex = lookupStatic("/index.html");
      if (spaIndex !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(200);
          res.end();
          return;
        }
        sendFile(res, spaIndex, 200);
        return;
      }
`
    : ""
}${
        notFoundPage
          ? `      const notFound = lookupStatic("/404.html");
      if (notFound !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(404);
          res.end();
          return;
        }
        sendFile(res, notFound, 404);
        return;
      }
`
          : ""
      }    }
`
    : "";

  const handlerDispatch = handlerIsFetch
    ? `
    const request = await toRequest(req);
    const response = await (${options.handler.expr})(request);
    await writeResponse(res, response);
`
    : `
    await (${options.handler.expr})(endedGet(req), res);
`;

  const nodeHelpers = handlerIsFetch
    ? ""
    : `
const endedGet = (req) => {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return req;
  if (req.readableEnded || req.complete) return req;
  // Bun's node:http IncomingMessage often never emits "end" for GET, so
  // nitro/h3 toNodeListener waits forever. Fly's edge proxy completes the
  // stream; Hetzner hits bun directly. Hand nitro an already-ended clone.
  const clone = new PassThrough();
  clone.method = req.method;
  clone.url = req.url;
  clone.headers = req.headers;
  clone.rawHeaders = req.rawHeaders;
  clone.httpVersion = req.httpVersion ?? "1.1";
  clone.httpVersionMajor = req.httpVersionMajor ?? 1;
  clone.httpVersionMinor = req.httpVersionMinor ?? 1;
  clone.socket = req.socket;
  clone.connection = req.connection ?? req.socket;
  clone.complete = true;
  clone.aborted = false;
  clone.push(null);
  req.resume();
  return clone;
};
`;

  const fetchHelpers = handlerIsFetch
    ? `
const header = (req, name) => {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
};

const toRequest = (req) => {
  const proto = header(req, "x-forwarded-proto") ?? "http";
  const host = header(req, "host") ?? "localhost";
  const url = proto + "://" + host + (req.url ?? "/");
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const body =
    method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req);
  return new Request(url, { method, headers, body, duplex: "half" });
};

const writeResponse = async (res, response) => {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end();
  }
};
`
    : "";

  return `// Generated by @alchemy.run/frontend-frameworks — Node container serve entry.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
${options.handler.imports}

const PORT = Number.parseInt(process.env.PORT ?? "${String(port)}", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
${staticBlock}${fetchHelpers}${nodeHelpers}
const pathnameOf = (url) => {
  try {
    return decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  } catch {
    return "/";
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = pathnameOf(req.url ?? "/");
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      urlPath === "/health"
    ) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
${staticDispatch}${handlerDispatch}  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
});

server.listen(PORT, HOST);
`;
};

export interface WriteNodeServeEntryOptions extends NodeServeEntryOptions {
  readonly output: BuildOutput;
  /** Absolute path of the serve-entry file to write. */
  readonly servePath: string;
  /**
   * Module name relative to `distDirectory` (POSIX), e.g.
   * `server/serve-node.mjs`. Becomes `serverModules[0]`.
   */
  readonly serveModuleName: string;
  readonly platform?: string | undefined;
}

/** Write the serve entry to disk and pin it as `serverModules[0]`. */
export const writeNodeServeEntry = (
  options: WriteNodeServeEntryOptions,
): Effect.Effect<
  BuildOutput,
  DeployTargetError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (message: string) => (cause?: unknown) =>
      new DeployTargetError({
        platform: options.platform ?? "node",
        message,
        cause,
      });
    const source = makeNodeServeEntrySource(options);
    yield* fs
      .makeDirectory(path.dirname(options.servePath), { recursive: true })
      .pipe(Effect.mapError(fail("Failed to create the Node serve directory")));
    yield* fs
      .writeFileString(options.servePath, source)
      .pipe(Effect.mapError(fail("Failed to write the Node serve entry")));
    const serveModule = yield* toOutputFile(options.serveModuleName, source);
    return pinNodeServeModule(options.output, serveModule);
  });
