/**
 * Process entry for an async (non-Effect) program on
 * `Azure.ContainerInstance.ContainerGroup`. The generated entry imports this
 * module and the user's handler file, nothing else, so the image carries no
 * Effect runtime.
 *
 * The handler file default-exports `{ fetch(request, env) }`. A Node HTTP
 * server on `PORT` turns each request into a web-standard `Request` and
 * writes back the `Response`. `env` holds the values of the group's `env`
 * prop, decoded from environment variables: strings stay strings, resources
 * arrive as their attributes, and secrets arrive as plain strings.
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

const toRequest = (req: IncomingMessage): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    // Node's web stream type and the DOM `BodyInit` type are the same
    // object at runtime but unrelated to the compiler.
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    // Required by Node's fetch for a streamed request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
};

const writeResponse = async (response: Response, res: ServerResponse) => {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.appendHeader(name, value));
  const body = response.body === null ? undefined : new Uint8Array(await response.arrayBuffer());
  res.end(body);
};

/** Serve `handler.fetch` on `PORT` until the container stops. */
export const serve = (handler: AsyncHandler, envKeys: readonly string[]) => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  const fetch = handler.fetch;
  const server = createServer((req, res) => {
    const respond = async () => {
      const response =
        fetch === undefined
          ? new Response("Not Found", { status: 404 })
          : await fetch.call(handler, toRequest(req), env);
      await writeResponse(response, res);
    };
    respond().catch((error: unknown) => {
      console.error("request failed:", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
    console.log(`Azure container group listening on ${process.env.PORT ?? 3000}`);
  });
};
