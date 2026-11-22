import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeAzureServeEntrySource } from "../AzureServe.ts";
import type { NodeServeEntryOptions } from "../NodeServe.ts";

type Entry = { default: { fetch(request: Request): Promise<Response> } };

const entry = (options: NodeServeEntryOptions) =>
  Effect.gen(function* () {
    const source = makeAzureServeEntrySource(options).replace(
      'from "srvx/node"',
      `from ${JSON.stringify(import.meta.resolve("srvx/node"))}`,
    );
    const specifier = yield* Effect.sync(
      () => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
    );
    return yield* Effect.tryPromise(() => import(specifier) as Promise<Entry>);
  });

const call = (module: Entry, request: Request) =>
  Effect.tryPromise(() => module.default.fetch(request));
const text = (response: Response) => Effect.tryPromise(() => response.text());

const echoUrl = {
  kind: "fetch",
  imports: "",
  expr: "request => new Response(request.url, { headers: { 'x-method': request.method } })",
} as const;

const functionUrl = "https://site-abc.azurewebsites.net/products/42?q=1";

describe("Azure Functions Fetch entry", () => {
  it("rewrites the request URL to the Front Door host from X-Forwarded-Host", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const module = yield* entry({ handler: echoUrl });
        const response = yield* call(
          module,
          new Request(functionUrl, { headers: { "x-forwarded-host": "web-x1.z01.azurefd.net" } }),
        );
        expect(yield* text(response)).toBe("https://web-x1.z01.azurefd.net/products/42?q=1");
      }),
    ));

  it("keeps the function URL without a valid X-Forwarded-Host", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const module = yield* entry({ handler: echoUrl });
        expect(yield* text(yield* call(module, new Request(functionUrl)))).toBe(functionUrl);
        const spoofed = yield* call(
          module,
          new Request(functionUrl, { headers: { "x-forwarded-host": "evil.com/path" } }),
        );
        expect(yield* text(spoofed)).toBe(functionUrl);
      }),
    ));

  it("answers HEAD with the handler's status and headers and no body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const module = yield* entry({ handler: echoUrl });
        const head = yield* call(module, new Request(functionUrl, { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(head.headers.get("x-method")).toBe("HEAD");
        expect(yield* text(head)).toBe("");
      }),
    ));

  it("answers 404 without a handler and 500 when the handler throws", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const empty = yield* entry({});
        const missing = yield* call(empty, new Request(functionUrl));
        expect(missing.status).toBe(404);
        expect(yield* text(missing)).toBe("Not Found");

        const failing = yield* entry({
          handler: { kind: "fetch", imports: "", expr: "() => { throw new Error('boom'); }" },
        });
        const failed = yield* call(failing, new Request(functionUrl));
        expect(failed.status).toBe(500);
        expect(yield* text(failed)).toBe("Internal Server Error");
      }),
    ));

  it("adapts a Node (req, res) handler to Fetch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const module = yield* entry({
          handler: {
            kind: "node",
            imports: "",
            expr: "(req, res) => { res.setHeader('x-node', '1'); res.end('node ' + req.url); }",
          },
        });
        const response = yield* call(module, new Request(functionUrl));
        expect(response.status).toBe(200);
        expect(response.headers.get("x-node")).toBe("1");
        expect(yield* text(response)).toBe("node /products/42?q=1");
      }),
    ));

  it("exports Fetch with no listening socket and no static file server", () => {
    const source = makeAzureServeEntrySource({
      clientDirExpression: JSON.stringify("/client"),
      handler: echoUrl,
    });
    expect(source).toContain("export default");
    expect(source).not.toContain(".listen(");
    expect(source).not.toContain("/client");
  });
});
