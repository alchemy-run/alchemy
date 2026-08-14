import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createEffectDispatch,
  toWebRequest,
  writeWebResponse,
  type EffectDispatchHandle,
} from "../EffectDispatch.ts";

const tempDirs: Array<string> = [];
const makeTempDir = (): string => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "alchemy-nextjs-effect-dispatch-test-"),
  );
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Per-test hooks the serve-module fixture reads off `globalThis`. */
interface ServeTestState {
  made: Array<readonly string[] | undefined>;
  disposed: Array<{ version?: number }>;
  calls: Array<{ method: string; url: string }>;
  match: (
    site: { version?: number },
    request: Request,
  ) => Promise<Response | undefined>;
}
const STATE_KEY = "__alchemyEffectDispatchTest";
const state = (): ServeTestState =>
  (globalThis as Record<string, unknown>)[STATE_KEY] as ServeTestState;

/**
 * A structural stand-in for `alchemy/Serve` (the `ServeModule` slice) —
 * the dispatch is exercised against the seam's CONTRACT (pre-gate on
 * `isRpcPath`/`matchRoutes`, `match` → write-or-decline, `dispose`), not
 * against alchemy itself (this package deliberately does not import it).
 */
const SERVE_FIXTURE = `
export const DEFAULT_SERVER_ROUTES = ["/api/*"];
export const isRpcPath = (pathname) => pathname === "/api/__rpc";
export const matchRoutes = (routes, pathname) =>
  routes.some((route) =>
    route.endsWith("/*")
      ? pathname === route.slice(0, -2) || pathname.startsWith(route.slice(0, -1))
      : pathname === route,
  );
export const make = (site, options) => {
  globalThis.${STATE_KEY}.made.push(options?.routes);
  return {
    match: async (request) => {
      const s = globalThis.${STATE_KEY};
      s.calls.push({ method: request.method, url: request.url });
      return s.match(site, request);
    },
  };
};
export const dispose = async (site) => {
  globalThis.${STATE_KEY}.disposed.push(site);
};
`;

let serveModule: string;
let staticBackend: string;
beforeAll(() => {
  const dir = makeTempDir();
  serveModule = NodePath.join(dir, "serve.mjs");
  NodeFs.writeFileSync(serveModule, SERVE_FIXTURE);
  staticBackend = NodePath.join(dir, "backend.mjs");
  NodeFs.writeFileSync(staticBackend, "export default { version: 0 };\n");
});

beforeEach(() => {
  (globalThis as Record<string, unknown>)[STATE_KEY] = {
    made: [],
    disposed: [],
    calls: [],
    match: async () => undefined,
  } satisfies ServeTestState;
});

const handles: Array<EffectDispatchHandle> = [];
const servers: Array<NodeHttp.Server> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

/**
 * The custom-server shape both consumers use: offer to the dispatch
 * first, fall through to a "framework" responder that echoes the (still
 * pristine) request body — proving a declined request's node stream was
 * never touched.
 */
const serveWith = async (handle: EffectDispatchHandle): Promise<string> => {
  const server = NodeHttp.createServer((req, res) => {
    void handle
      .dispatch(req, res)
      .then((handled) => {
        if (handled) return;
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += String(chunk);
        });
        req.on("end", () => {
          res.writeHead(418, { "x-served-by": "framework" });
          res.end(`framework:${body}`);
        });
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as NodeNet.AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const makeDispatch = async (
  options: {
    main?: string;
    routes?: readonly string[];
    watch?: boolean;
  } = {},
): Promise<EffectDispatchHandle> => {
  const handle = await createEffectDispatch({
    main: options.main ?? staticBackend,
    routes: options.routes,
    serveModule,
    watch: options.watch,
  });
  handles.push(handle);
  return handle;
};

describe("toWebRequest", () => {
  const fakeReq = (options: {
    method?: string;
    url?: string;
    headers?: NodeHttp.IncomingHttpHeaders;
    chunks?: Array<string>;
  }): NodeHttp.IncomingMessage =>
    Object.assign(
      Readable.from((options.chunks ?? []).map((chunk) => Buffer.from(chunk))),
      {
        method: options.method,
        url: options.url,
        headers: options.headers ?? {},
      },
    ) as unknown as NodeHttp.IncomingMessage;

  it("builds the url from the host header", () => {
    const request = toWebRequest(
      fakeReq({
        url: "/a/b?c=1",
        headers: { host: "example.com:8787" },
      }),
    );
    expect(request.url).toBe("http://example.com:8787/a/b?c=1");
    expect(request.method).toBe("GET");
  });

  it("folds multi-value headers with append", () => {
    const request = toWebRequest(
      fakeReq({
        headers: { "x-multi": ["a", "b"], accept: "text/html" },
      }),
    );
    expect(request.headers.get("x-multi")).toBe("a, b");
    expect(request.headers.get("accept")).toBe("text/html");
  });

  it("attaches a body only for body-carrying methods", async () => {
    expect(toWebRequest(fakeReq({ method: "GET" })).body).toBeNull();
    expect(toWebRequest(fakeReq({ method: "HEAD" })).body).toBeNull();
    const post = toWebRequest(
      fakeReq({ method: "POST", chunks: ["hel", "lo"] }),
    );
    expect(await post.text()).toBe("hello");
  });
});

describe("writeWebResponse", () => {
  const respondWith = async (make: () => Response): Promise<Response> => {
    const server = NodeHttp.createServer((_req, res) => {
      void writeWebResponse(res, make()).catch(() => res.end());
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address() as NodeNet.AddressInfo;
    return fetch(`http://127.0.0.1:${address.port}/`);
  };

  it("preserves status, headers, and multi-value set-cookie", async () => {
    const headers = new Headers({ "x-custom": "yes" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const response = await respondWith(
      () => new Response("ok", { status: 207, headers }),
    );
    expect(response.status).toBe(207);
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
    expect(await response.text()).toBe("ok");
  });

  it("streams the body chunk-by-chunk", async () => {
    const response = await respondWith(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of ["one ", "two ", "three"]) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            },
          }),
        ),
    );
    expect(await response.text()).toBe("one two three");
  });

  it("ends a null-body response", async () => {
    const response = await respondWith(
      () => new Response(null, { status: 204 }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("createEffectDispatch", () => {
  it("dispatches a claimed route to the effect handler", async () => {
    state().match = async () =>
      new Response("from-effect", {
        status: 201,
        headers: { "x-effect": "yes" },
      });
    const url = await serveWith(await makeDispatch());
    const response = await fetch(`${url}/api/hello`);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-effect")).toBe("yes");
    expect(await response.text()).toBe("from-effect");
    expect(state().calls).toEqual([
      { method: "GET", url: expect.stringContaining("/api/hello") },
    ]);
  });

  it("declines an unclaimed path without consulting the effect program", async () => {
    const url = await serveWith(await makeDispatch());
    const response = await fetch(`${url}/other/page`, {
      method: "POST",
      body: "raw-body",
    });
    expect(response.status).toBe(418);
    expect(response.headers.get("x-served-by")).toBe("framework");
    // The framework read the body intact — the pre-gate declined before
    // ever constructing a Request over the node stream.
    expect(await response.text()).toBe("framework:raw-body");
    expect(state().calls).toEqual([]);
  });

  it("always claims the rpc path, even outside the routes claim", async () => {
    state().match = async (_site, request) =>
      new Response(`rpc:${await request.text()}`);
    const url = await serveWith(await makeDispatch({ routes: ["/never/*"] }));
    const rpc = await fetch(`${url}/api/__rpc`, {
      method: "POST",
      body: "ping",
    });
    expect(await rpc.text()).toBe("rpc:ping");
    // The narrowed claim excludes plain /api paths — the framework serves.
    const outside = await fetch(`${url}/api/hello`);
    expect(outside.headers.get("x-served-by")).toBe("framework");
  });

  it("falls through to the framework when the effect program declines a claimed path", async () => {
    const url = await serveWith(await makeDispatch());
    const response = await fetch(`${url}/api/declined`);
    expect(response.status).toBe(418);
    expect(response.headers.get("x-served-by")).toBe("framework");
    expect(state().calls).toHaveLength(1);
  });

  it("defaults the routes claim to the serve module's DEFAULT_SERVER_ROUTES", async () => {
    await makeDispatch();
    expect(state().made).toEqual([["/api/*"]]);
    await makeDispatch({ routes: ["/only/*", "!/only/skip"] });
    expect(state().made[1]).toEqual(["/only/*", "!/only/skip"]);
  });

  it("fails loudly when the backend module has no default export", async () => {
    const dir = makeTempDir();
    const main = NodePath.join(dir, "no-default.mjs");
    NodeFs.writeFileSync(main, "export const nope = 1;\n");
    await expect(createEffectDispatch({ main, serveModule })).rejects.toThrow(
      /no default export/,
    );
  });

  it("disposes the current generation on close", async () => {
    const handle = await createEffectDispatch({
      main: staticBackend,
      serveModule,
    });
    await handle.close();
    expect(state().disposed).toHaveLength(1);
  });

  it("hot-swaps the backend generation on edit (watch: true)", async () => {
    state().match = async (site) => new Response(String(site.version));
    const dir = makeTempDir();
    const main = NodePath.join(dir, "backend.mjs");
    NodeFs.writeFileSync(main, "export default { version: 1 };\n");
    const url = await serveWith(await makeDispatch({ main, watch: true }));
    expect(await (await fetch(`${url}/api/version`)).text()).toBe("1");

    NodeFs.writeFileSync(main, "export default { version: 2 };\n");
    let body = "";
    for (let attempt = 0; attempt < 40 && body !== "2"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      body = await (await fetch(`${url}/api/version`)).text();
    }
    expect(body).toBe("2");
    // The retired generation drained and was disposed.
    expect(state().disposed.some((site) => site.version === 1)).toBe(true);
  });
});
