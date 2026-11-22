import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AZURE_SERVE_ENTRY_FILE_NAME } from "../../core/AzureServe.ts";
import { isDeployTarget } from "../../core/index.ts";
import { makeProject, run } from "../../core/test/helpers.ts";
import { makeSvelteKitAzureTarget, prerenderedPages, target } from "../azure.ts";

type Entry = { default: { fetch(request: Request): Promise<Response> } };

const siteHost = "web-x1.z01.azurefd.net";
const functionUrl = "https://site-abc.azurewebsites.net";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeSvelteKitAzureTarget", () => {
  it("is a DeployTarget for the azure platform with build and finish passes", () => {
    const azure = makeSvelteKitAzureTarget();
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
    expect(target).toBe(makeSvelteKitAzureTarget);
  });

  it("maps HTML files in the client directory to their routes", async () => {
    const root = await makeProject({
      "client/index.html": "home",
      "client/about.html": "about",
      "client/docs/index.html": "docs",
      "client/blog/post one.html": "post",
      "client/both.html": "file wins",
      "client/both/index.html": "index loses",
      "client/_app/immutable/app.js": "js",
      "client/robots.txt": "robots",
    });
    const pages = await run(prerenderedPages(path.join(root, "client")));
    expect(pages).toEqual({
      "/": "/index.html",
      "/about": "/about.html",
      "/docs": "/docs/index.html",
      "/docs/": "/docs/index.html",
      "/blog/post one": "/blog/post%20one.html",
      "/both": "/both.html",
      "/both/": "/both/index.html",
    });
  });

  it("serves prerendered pages from the site host and everything else through kit", async () => {
    const root = await makeProject({
      "entry.js":
        'export const handler = (request) => new Response("kit " + new URL(request.url).pathname, { status: new URL(request.url).pathname === "/about" ? 404 : 200, headers: { "x-rendered-by": "kit" } });',
      ".svelte-kit/node/about.html": "<h1>about</h1>",
      ".svelte-kit/node/_app/immutable/app.js": "js",
    });
    const output = await run(
      makeSvelteKitAzureTarget().finish!(
        {
          distDirectory: path.join(root, "dist"),
          clientDirectory: path.join(root, ".svelte-kit/node"),
          serverModules: [],
          externalWorkspaces: new Set(),
        },
        { root, entry: path.join(root, "entry.js") },
      ),
    );
    const entry = output.serverModules![0]!.name;
    expect(entry).toBe(`server/${AZURE_SERVE_ENTRY_FILE_NAME}`);

    const upstream = vi.fn(
      async (_url: URL, _init?: RequestInit) =>
        new Response("<h1>about from blob</h1>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "max-age=0",
            "x-ms-request-id": "blob",
          },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const module = (await import(pathToFileURL(path.join(root, "dist", entry)).href)) as Entry;
    const forwarded = { headers: { "x-forwarded-host": siteHost } };

    const about = await module.default.fetch(new Request(`${functionUrl}/about?x=1`, forwarded));
    expect(about.status).toBe(200);
    expect(await about.text()).toBe("<h1>about from blob</h1>");
    expect(about.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(about.headers.get("cache-control")).toBe("max-age=0");
    expect(about.headers.get("x-ms-request-id")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0]![0])).toBe(`https://${siteHost}/about.html`);

    // Not a prerendered route: kit renders it, no upstream fetch.
    const home = await module.default.fetch(new Request(`${functionUrl}/`, forwarded));
    expect(await home.text()).toBe("kit /");
    expect(home.headers.get("x-rendered-by")).toBe("kit");
    // A POST to a prerendered route goes to kit.
    const post = await module.default.fetch(
      new Request(`${functionUrl}/about`, { method: "POST", ...forwarded }),
    );
    expect(post.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);

    // A failed upstream fetch falls through to kit.
    upstream.mockImplementationOnce(async () => new Response("missing", { status: 404 }));
    const fallback = await module.default.fetch(new Request(`${functionUrl}/about`, forwarded));
    expect(fallback.status).toBe(404);
    expect(await fallback.text()).toBe("kit /about");
  });
});
