import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AZURE_SERVE_ENTRY_FILE_NAME } from "../../core/AzureServe.ts";
import { makeProject } from "../../core/test/helpers.ts";
import {
  makeNextAzureServeEntrySource,
  NODE_ADAPTER_FILE_NAME,
  SERVE_ENTRY_FILE_NAME,
} from "../azure.ts";

type Entry = { default: { fetch(request: Request): Promise<Response> } };

// A stand-in for the standalone `next` package: it records how the entry
// starts Next and answers with what Next's request handler would see.
const FAKE_NEXT = `
const requestMeta = require("./dist/server/request-meta.js");
let starts = 0;
module.exports = (options) => ({
  prepare: async () => { starts++; },
  getRequestHandler: () => (req, res) => {
    const meta = requestMeta.getRequestMeta(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      starts,
      dev: options.dev,
      conf: options.conf,
      standaloneConfig: process.env.__NEXT_PRIVATE_STANDALONE_CONFIG,
      url: req.url,
      method: req.method,
      host: req.headers.host,
      forwardedHost: req.headers["x-forwarded-host"],
      forwardedProto: req.headers["x-forwarded-proto"],
      forwardedPort: req.headers["x-forwarded-port"],
      initURL: meta.initURL,
      initProtocol: meta.initProtocol,
    }));
  },
});
`;

const FAKE_REQUEST_META = `
const key = Symbol.for("NextInternalRequestMeta");
exports.getRequestMeta = (req) => req[key] ?? {};
exports.setRequestMeta = (req, meta) => { req[key] = meta; };
`;

const nextConfig = { distDir: ".next", output: "standalone", basePath: "" };

const restore = { cwd: process.cwd(), env: { ...process.env } };
afterEach(() => {
  process.chdir(restore.cwd);
  process.env = { ...restore.env };
});

const loadEntry = async () => {
  const dir = await makeProject({
    [SERVE_ENTRY_FILE_NAME]: makeNextAzureServeEntrySource(nextConfig),
    [NODE_ADAPTER_FILE_NAME]: `export * from ${JSON.stringify(import.meta.resolve("srvx/node"))};`,
    "node_modules/next/package.json": JSON.stringify({ name: "next", main: "index.js" }),
    "node_modules/next/index.js": FAKE_NEXT,
    "node_modules/next/dist/server/request-meta.js": FAKE_REQUEST_META,
  });
  return (await import(pathToFileURL(`${dir}/${SERVE_ENTRY_FILE_NAME}`).href)) as Entry;
};

describe("Next.js Azure Functions entry", () => {
  it("is the shared Azure Fetch entry file next to the srvx adapter", () => {
    expect(SERVE_ENTRY_FILE_NAME).toBe(AZURE_SERVE_ENTRY_FILE_NAME);
    const source = makeNextAzureServeEntrySource(nextConfig);
    expect(source).toContain(`from "./${NODE_ADAPTER_FILE_NAME}"`);
    expect(source).toContain(`const nextConfig = ${JSON.stringify(nextConfig)};`);
    expect(source).toContain("export default {");
  });

  it("starts Next once in production and answers with the Front Door URL", async () => {
    const entry = await loadEntry();
    const response = await entry.default.fetch(
      new Request("https://web-fn.azurewebsites.net/products/42?q=1", {
        headers: { "x-forwarded-host": "web-x1.z01.azurefd.net" },
      }),
    );
    expect(response.status).toBe(200);
    const seen = (await response.json()) as Record<string, unknown>;
    expect(seen).toEqual({
      starts: 1,
      dev: false,
      conf: nextConfig,
      standaloneConfig: JSON.stringify(nextConfig),
      url: "/products/42?q=1",
      method: "GET",
      host: "web-x1.z01.azurefd.net",
      forwardedHost: "web-x1.z01.azurefd.net",
      forwardedProto: "https",
      forwardedPort: "443",
      initURL: "https://web-x1.z01.azurefd.net/products/42?q=1",
      initProtocol: "https",
    });
    expect(process.env.NODE_ENV).toBe("production");

    const second = await entry.default.fetch(
      new Request("https://web-fn.azurewebsites.net/", { method: "POST", body: "x" }),
    );
    const again = (await second.json()) as Record<string, unknown>;
    expect(again.starts).toBe(1);
    expect(again.method).toBe("POST");
    expect(again.host).toBe("web-fn.azurewebsites.net");
  });
});
