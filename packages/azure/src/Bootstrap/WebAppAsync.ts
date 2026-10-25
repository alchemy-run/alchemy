/**
 * Process entry for an async (non-Effect) `Azure.Web.WebApp`. The generated
 * entry imports this module and the user's handler file, nothing else, so
 * the deployed package carries no Effect runtime.
 *
 * The handler file default-exports `{ fetch(request, env) }`. {@link serve}
 * starts a Node HTTP server on `PORT` (App Service sets it) and answers each
 * request with `fetch`. `env` holds the values of the app's `env` prop,
 * decoded from app settings: strings stay strings, resources arrive as their
 * attributes, and secrets arrive as plain strings.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** The shape an async handler file default-exports. */
export interface AsyncHandler {
  fetch?: (request: Request, env: any) => Response | Promise<Response>;
}

// Must stay in step with `packEnvValue` in `alchemy/RuntimeContext`.
const decode = (raw: string | undefined): unknown => {
  if (raw === undefined || !/^[\x20\t\r\n]*["{[0-9tfn-]/.test(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { _tag?: unknown })._tag === "Redacted" &&
      typeof (parsed as { value?: unknown }).value === "string"
    ) {
      return (parsed as { value: string }).value;
    }
    return parsed;
  } catch {
    return raw;
  }
};

const firstHeader = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

/** App Service terminates TLS at its front end and forwards plain HTTP. */
const toRequest = (req: IncomingMessage): Request => {
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "http";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  // A streamed body needs `duplex: "half"`, which `RequestInit` does not
  // declare; Node's web stream type differs from the DOM one only nominally.
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
  };
  return new Request(new URL(req.url ?? "/", `${proto}://${host}`), init);
};

const send = async (res: ServerResponse, response: Response, method: string | undefined) => {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (response.body === null || method === "HEAD") {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
};

/** Serve `handler.fetch` on `PORT` (default 8080). */
export const serve = (handler: AsyncHandler, envKeys: readonly string[]) => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  const fetch = handler.fetch;
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer((req, res) => {
    const respond = async () => {
      const response =
        fetch === undefined
          ? new Response("Not Found", { status: 404 })
          : await fetch.call(handler, toRequest(req), env);
      await send(res, response, req.method);
    };
    respond().catch((error: unknown) => {
      console.error("Azure web app handler failed:", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Azure web app listening on ${port}`);
  });
  return server;
};
