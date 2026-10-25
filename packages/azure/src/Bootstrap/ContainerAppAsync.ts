/**
 * Process entry for an async (non-Effect) `Azure.ContainerApps.ContainerApp`.
 * The generated entry imports this module and the user's handler file,
 * nothing else, so the image carries no Effect runtime.
 *
 * The handler file default-exports `{ fetch(request, env) }`. `env` holds the
 * values of the app's `env` prop, decoded from the container's env vars:
 * strings stay strings, resources arrive as their attributes, and secrets
 * arrive as plain strings. Node's HTTP server serves `fetch` on `PORT`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

const readBody = (req: IncomingMessage) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const toRequest = async (req: IncomingMessage): Promise<Request> => {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  return new Request(`${proto}://${host}${req.url ?? "/"}`, { method, headers, body });
};

const send = async (res: ServerResponse, response: Response, head: boolean) => {
  const headers: Record<string, string[]> = {};
  response.headers.forEach((value, name) => {
    (headers[name] ??= []).push(value);
  });
  res.writeHead(response.status, headers);
  res.end(head ? undefined : new Uint8Array(await response.arrayBuffer()));
};

/** Serve `handler.fetch` on `PORT` (default 8080) for every request. */
export const serve = (handler: AsyncHandler, envKeys: readonly string[]) => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  const port = Number(process.env.PORT ?? "8080");
  createServer((req, res) => {
    const fetch = handler.fetch;
    const respond = async () => {
      if (fetch === undefined) return new Response("Not Found", { status: 404 });
      return await fetch.call(handler, await toRequest(req), env);
    };
    respond()
      .catch((error: unknown) => {
        console.error("Azure Container App handler failed:", error);
        return new Response("Internal Server Error", { status: 500 });
      })
      .then((response) => send(res, response, req.method === "HEAD"))
      .catch((error: unknown) => {
        console.error("Azure Container App response failed:", error);
        res.destroy();
      });
  }).listen(port, "0.0.0.0", () => {
    console.log(`Azure Container App listening on ${port}`);
  });
};
