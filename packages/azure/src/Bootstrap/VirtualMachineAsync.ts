/**
 * Process entry for an async (non-Effect) `Azure.Compute.VirtualMachine`
 * program. The generated entry imports this module and the user's handler
 * file, nothing else, so the deployed program carries no Effect runtime.
 *
 * The handler file default-exports `{ fetch(request, env) }`. A Node HTTP
 * server on `PORT` (all interfaces) turns each request into a web `Request`.
 * `env` holds the values of the VM's `env` prop: strings stay strings,
 * resources arrive as their attributes, and secrets arrive as plain strings.
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { decodeEnvValue } from "./VirtualMachineCore.ts";

export { loadEnv } from "./VirtualMachineCore.ts";

/** The shape an async handler file default-exports. */
export interface AsyncHandler {
  fetch?: (request: Request, env: any) => Response | Promise<Response>;
}

/** Serve `handler.fetch` on `PORT` (default 3000). */
export const serve = (handler: AsyncHandler, envKeys: readonly string[]) => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decodeEnvValue(process.env[key]);
  const port = Number(process.env.PORT ?? 3000);

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      }
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method,
        headers,
        // Node's web stream type and the DOM `BodyInit` type are the same
        // object at runtime but unrelated to the compiler.
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
        // Required by Node's fetch for a streamed request body.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
      const response =
        handler.fetch === undefined
          ? new Response("Not Found", { status: 404 })
          : await handler.fetch.call(handler, request, env);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.appendHeader(key, value));
      if (response.body === null || method === "HEAD") {
        res.end();
        return;
      }
      // Same runtime object, distinct compiler types (see above).
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(
        res,
      );
    } catch (error) {
      console.error("handler failed:", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Azure virtual machine program listening on ${port}`);
  });
};
