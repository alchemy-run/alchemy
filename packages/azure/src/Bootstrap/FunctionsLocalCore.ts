/**
 * The local runtime of `Azure.Functions.Function` under `alchemy dev`,
 * shared by the Effect and async local bootstraps. Free of Effect so the
 * async bundle carries no Effect runtime.
 *
 * Instead of the Functions worker, a Node.js HTTP server on `PORT` forwards
 * every request to the program's `fetch`, exactly like the catch-all HTTP
 * function in Azure (route `{*path}`, empty route prefix).
 *
 * Storage calls to the local emulator: a local storage account is Azurite's
 * `devstoreaccount1`, so a binding addresses
 * `https://devstoreaccount1.blob.core.windows.net`. {@link installStorageEmulator}
 * routes those requests to the Azurite endpoints the local provider puts in
 * the env (`ALCHEMY_AZURITE_*`) and signs them with its SAS. Every other
 * request is untouched.
 */
import * as http from "node:http";

/** Line the server prints on stdout once it accepts requests. */
export const READY_LINE = "alchemy:azure-function-ready";

const STORAGE_HOST = /^([a-z0-9]+)\.(blob|queue|table)\.core\.windows\.net$/;

/** Route Storage requests for the emulator's account to Azurite (see the module doc). */
export const installStorageEmulator = (env: NodeJS.ProcessEnv = process.env): void => {
  const account = env.ALCHEMY_AZURITE_ACCOUNT;
  const sas = env.ALCHEMY_AZURITE_SAS;
  const targets: Record<string, string | undefined> = {
    blob: env.ALCHEMY_AZURITE_BLOB,
    queue: env.ALCHEMY_AZURITE_QUEUE,
    table: env.ALCHEMY_AZURITE_TABLE,
  };
  if (account === undefined || sas === undefined) return;
  const original = globalThis.fetch;
  const emulated = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = STORAGE_HOST.exec(url.hostname);
    const base = match !== null && match[1] === account ? targets[match[2]!] : undefined;
    if (base === undefined) return original(input, init);
    // Path-style emulator URL; the SAS replaces the bearer token.
    const query = url.search ? `${url.search}&${sas}` : `?${sas}`;
    const target = `${base.replace(/\/+$/, "")}${url.pathname}${query}`;
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    return original(target, {
      method: request.method,
      headers,
      body,
      redirect: request.redirect,
      signal: request.signal,
    });
  };
  globalThis.fetch = Object.assign(emulated, original);
};

const toRequest = async (req: http.IncomingMessage, port: number): Promise<Request> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk as Uint8Array);
    body = new Uint8Array(Buffer.concat(chunks));
  }
  const host = req.headers.host ?? `localhost:${port}`;
  return new Request(`http://${host}${req.url ?? "/"}`, { method, headers, body });
};

const writeResponse = async (res: http.ServerResponse, response: Response) => {
  res.statusCode = response.status;
  for (const cookie of response.headers.getSetCookie()) res.appendHeader("set-cookie", cookie);
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
};

/**
 * Serve `handler` on `PORT` (IPv4 and, when available, IPv6 loopback), then
 * print {@link READY_LINE}. Without a handler every request answers 404.
 */
export const listen = async (
  handler: ((request: Request) => Promise<Response>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const port = Number(env.PORT ?? 7071);
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      try {
        if (handler === undefined) {
          res.statusCode = 404;
          res.end("this Function has no fetch handler");
          return;
        }
        await writeResponse(res, await handler(await toRequest(req, port)));
      } catch (error) {
        console.error("request failed", error);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    })();
  };
  const bind = (host: string) =>
    new Promise<void>((resolve, reject) => {
      const server = http.createServer(onRequest);
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  await bind("127.0.0.1");
  // `localhost` may resolve to ::1 first; serve there too when the host has IPv6.
  await bind("::1").catch(() => undefined);
  console.log(READY_LINE);
};
