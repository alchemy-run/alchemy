/**
 * Bootstrap for an async (non-Effect) `AWS.Lambda.WebFunction`. The
 * generated entry imports `listenAddress` from `./LambdaWebEnv.ts`, then the
 * user's `main`, then calls {@link serve} with the module namespace and the
 * address.
 *
 * Two module shapes are supported:
 *
 * - A module that starts its own server (`app.listen(port, host)` with
 *   Express, Fastify, `@hono/node-server`, …). `LambdaWebEnv` has already
 *   mirrored `AWS_LAMBDA_HTTP_ENDPOINT` into `PORT` / `HOST`, and `serve`
 *   does nothing.
 * - A module whose default export (or the module itself) has a Web-standard
 *   `fetch(request)` — the Cloudflare Worker / Hono shape. `serve` starts a
 *   Node HTTP server on the Lambda address and streams each `Response` body
 *   back as it is produced.
 */
import { once } from "node:events";
import * as http from "node:http";
import { Readable } from "node:stream";
import type { LambdaHttpEndpoint } from "./LambdaWebEnv.ts";

type FetchHandler = (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;

const fetchHandlerOf = (module: any): FetchHandler | undefined => {
  const app = module?.default;
  if (app !== undefined && app !== null && typeof app.fetch === "function") {
    return app.fetch.bind(app);
  }
  if (typeof module?.fetch === "function") {
    return module.fetch;
  }
  return undefined;
};

const toRequest = (req: http.IncomingMessage, signal: AbortSignal): Request => {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
          duplex: "half",
        }
      : {}),
  } as RequestInit);
};

const writeResponse = async (response: Response, res: http.ServerResponse) => {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  // Write chunk by chunk, honoring backpressure, so streamed bodies
  // (server-sent events, token streams) reach the client as produced.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (!res.write(chunk)) {
      await once(res, "drain");
    }
  }
  res.end();
};

/**
 * Serve the module's `fetch` handler on `AWS_LAMBDA_HTTP_ENDPOINT`, or do
 * nothing when the module listens on its own.
 */
export const serve = (module: unknown, { host, port }: LambdaHttpEndpoint): void => {
  const handler = fetchHandlerOf(module);
  if (handler === undefined) return;

  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    Promise.resolve()
      .then(() => handler(toRequest(req, controller.signal), process.env, undefined))
      .then((response) => writeResponse(response, res))
      .catch((error) => {
        console.error("[alchemy] fetch handler failed", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end();
      });
  });

  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      // The module started its own server on the Lambda address as well
      // as exporting `fetch`; that server is already serving requests.
      console.warn(`[alchemy] ${host}:${port} is already in use, not serving the fetch export`);
      return;
    }
    console.error("[alchemy] HTTP server failed", error);
    process.exit(1);
  });
  server.listen(port, host);

  // Lambda sends SIGTERM and allows 1 second before it terminates the
  // environment: stop accepting, let in-flight responses finish, and exit.
  process.once("SIGTERM", () => {
    setTimeout(() => process.exit(0), 900).unref();
    server.close(() => process.exit(0));
  });
};
