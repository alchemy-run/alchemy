import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";

export type FoldkitMode = "spa" | "ssg" | "ssr" | "hybrid" | "static";
export const foldkitModes = ["spa", "ssg", "ssr", "hybrid"] as const;
export const foldkitChecks = ["http", "browser"] as const;
export const browserEnabled = process.env.FOLDKIT_WEBSITE_BROWSER === "1";
export const foldkitMemo = {
  include: [
    "index.html",
    "src/**",
    "public/**",
    "package.json",
    "vite.config.ts",
  ],
};

/** Private copies let each lifecycle choose its rendering mode without mutating a shared fixture. */
export const foldkitFixture = (mode: FoldkitMode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* cloneFixture(
      path.join(
        import.meta.dirname,
        "../Cloudflare/Website",
        mode === "spa" ? "foldkit-fixture" : "foldkit-ssr-fixture",
      ),
      {
        prefix: `foldkit-${mode}-`,
        tempRoot: path.resolve(import.meta.dirname, "../../.tmp"),
        entries: [
          "package.json",
          "vite.config.ts",
          "src",
          ...(mode === "spa" ? ["index.html"] : []),
        ],
      },
    );
    yield* fs.makeDirectory(path.join(root, "public"));
    yield* fs.writeFileString(
      path.join(root, "public/foldkit-probe.txt"),
      "FOLDKIT_STATIC_ASSET",
    );
    if (mode === "static") {
      yield* fs.writeFileString(
        path.join(root, "public/404.html"),
        "<!doctype html><title>Not Found</title><h1>Not Found</h1>",
      );
    }
    if (mode !== "spa") {
      yield* fs.writeFileString(
        path.join(root, "src/prerender.ts"),
        'export const prerenderPaths = ["/", "/about"];\n',
      );
      if (mode === "ssg") {
        const entry = path.join(root, "src/entry.server.ts");
        yield* fs.writeFileString(
          entry,
          (yield* fs.readFileString(entry)).replace(
            "Effect.gen(function* () {",
            `Effect.gen(function* () {
      const pathname = new URL(request.url).pathname.replace(/\\/+$/, "") || "/";
      if (pathname !== "/" && pathname !== "/about")
        return Server.Responded(new Response("Not Found", { status: 404 }));
      if (request.method !== "GET" && request.method !== "HEAD")
        return Server.Responded(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }));`,
          ),
        );
      }
      if (mode === "ssr") {
        const config = path.join(root, "vite.config.ts");
        yield* fs.writeFileString(
          config,
          (yield* fs.readFileString(config)).replace(
            "prerender: true",
            "prerender: false",
          ),
        );
      }
    }
    return root;
  });

const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(5000),
      });
      return {
        status: response.status,
        body: await response.text(),
        type: response.headers.get("content-type"),
      };
    },
    catch: (cause) => new Error(`Foldkit request failed: ${url}`, { cause }),
  });
const routes = (mode: FoldkitMode) => [
  { path: "/?count=7", count: mode === "ssr" ? 7 : 0 },
  { path: "/about/?count=9", count: mode === "ssr" ? 9 : 0 },
  ...(mode === "static" || mode === "ssg"
    ? []
    : [{ path: "/counter/42?count=3", count: mode === "spa" ? 0 : 3 }]),
];

/** Exercise the public origin, including asset routing and the actual deployed SSR handler. */
export const verifyFoldkitRendering = (origin: string, mode: FoldkitMode) =>
  Effect.gen(function* () {
    const base = origin.replace(/\/+$/, "");
    yield* request(`${base}/foldkit-probe.txt`).pipe(
      Effect.flatMap((result) =>
        result.status === 200 && result.body === "FOLDKIT_STATIC_ASSET"
          ? Effect.void
          : Effect.fail(
              new Error("Foldkit deployment is not serving its asset yet"),
            ),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
      Effect.timeout("60 seconds"),
    );
    const assetHead = yield* request(`${base}/foldkit-probe.txt`, {
      method: "HEAD",
    });
    expect(assetHead.status).toBe(200);
    expect(assetHead.body).toBe("");
    for (const route of routes(mode)) {
      const response = yield* request(base + route.path);
      expect(response.status).toBe(200);
      if (mode === "spa") {
        expect(response.body).toContain("Foldkit Fixture");
        expect(response.body).not.toMatch(/id="count"/);
      } else {
        expect(response.body).toMatch(
          new RegExp(`id="count"[^>]*>${route.count}<`),
        );
      }
      const script = response.body.match(/<script[^>]+src="([^" ]+)"/);
      expect(script).not.toBeNull();
      const javascript = yield* request(
        new URL(script![1]!, base + route.path).href,
      );
      expect(javascript.status).toBe(200);
      expect(javascript.type).toMatch(/javascript/);
      if (mode !== "spa") {
        const stylesheet = response.body.match(
          /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/,
        );
        expect(stylesheet).not.toBeNull();
        const css = yield* request(
          new URL(stylesheet![1]!, base + route.path).href,
        );
        expect(css.status).toBe(200);
        expect(css.type).toMatch(/text\/css/);
      }
      const head = yield* request(base + route.path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
    }
    if (mode === "ssr" || mode === "hybrid") {
      const posted = yield* request(`${base}/about/?count=11`, {
        method: "POST",
        body: "request body",
      });
      expect(posted.status).toBe(200);
      expect(posted.body).toMatch(/id="count"[^>]*>11</);
      expect((yield* request(`${base}/assets/missing.js`)).status).toBe(404);
    }
    if (mode === "ssg") {
      expect(
        (yield* request(`${base}/about/`, { method: "POST" })).status,
      ).toBe(405);
      expect((yield* request(`${base}/assets/missing.js`)).status).toBe(404);
    }
    if (mode === "static" || mode === "ssg")
      expect((yield* request(`${base}/not-prerendered`)).status).toBe(404);
  });

const browsers = Semaphore.makeUnsafe(1);
const command = (args: string[]) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make("terminal-browser", args, {
      env: { ...process.env, NODE_OPTIONS: undefined },
    });
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 3 },
    );
    if (code !== 0)
      return yield* Effect.fail(new Error(`Browser command failed: ${stderr}`));
    return stdout;
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"));

/** Called only by separately registered, opt-in browser cases, so skipped hydration is visible. */
export const verifyFoldkitBrowser = (origin: string, mode: FoldkitMode) =>
  Effect.gen(function* () {
    for (const route of routes(mode)) {
      yield* Effect.gen(function* () {
        const opened = yield* command([
          "new-tab",
          origin.replace(/\/+$/, "") + route.path,
        ]);
        const browser = yield* Effect.try(
          () =>
            JSON.parse(opened) as {
              key: string;
              openedTab?: number;
              tabs?: { id: number; active: boolean }[];
            },
        );
        const tab =
          browser.openedTab ?? browser.tabs?.find((tab) => tab.active)?.id;
        if (tab === undefined)
          return yield* Effect.fail(
            new Error("Browser did not report its active tab"),
          );
        const action = (...args: string[]) =>
          command([
            "action",
            "--browser",
            browser.key,
            "--tab",
            String(tab),
            "--",
            ...args,
          ]);
        yield* Effect.addFinalizer(() =>
          action("close").pipe(
            Effect.andThen(
              command([
                "action",
                "--browser",
                browser.key,
                "--tab",
                String(tab),
                "done",
              ]),
            ),
            Effect.ignore,
          ),
        );
        const countIs = (count: number) =>
          action(
            "eval",
            `document.readyState === "complete" && document.getElementById("count")?.textContent === ${JSON.stringify(String(count))} ? "FOLDKIT_COUNT_OK" : "WAITING"`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              times: 8,
              until: (text) => text.includes("FOLDKIT_COUNT_OK"),
            }),
            Effect.tap((text) =>
              Effect.sync(() => expect(text).toContain("FOLDKIT_COUNT_OK")),
            ),
          );
        yield* countIs(route.count);
        yield* action("click", "#increment");
        yield* countIs(route.count + 1);
        // A reload must hydrate the server's initial flags again, not retain the clicked state.
        yield* action("reload");
        yield* countIs(route.count);
        yield* action("click", "#increment");
        yield* countIs(route.count + 1);
      }).pipe(Effect.scoped);
    }
  }).pipe(browsers.withPermit, Effect.timeout("60 seconds"));
