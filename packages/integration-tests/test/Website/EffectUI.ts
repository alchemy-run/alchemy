import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";
import { expectDirectStatus, expectUrlContains } from "../Cloudflare/Utils/Http.ts";

/**
 * The rendering modes of `effect-ui-fixture`:
 *
 * - `spa`: no `HtmlServerVite`, the app mounts into the shell.
 * - `ssg`: `HtmlServerVite` without `serverOutDir`, prerendered pages only.
 * - `ssr`: a server handler and no prerendered pages.
 * - `hybrid`: a server handler and prerendered `/`, `/about` and `/404`.
 */
export type EffectUIMode = "spa" | "ssg" | "ssr" | "hybrid";
export const effectUIModes = ["spa", "ssg", "ssr", "hybrid"] as const;

export const effectUIMemo = {
  include: ["index.html", "src/**", "public/**", "package.json", "vite.config.ts"],
};

const fixtureDir = pathe.join(import.meta.dirname, "effect-ui-fixture");

/** Copy an overlay directory over a fixture clone, replacing same-named files. */
const overlay = (
  from: string,
  to: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(from))) return;
    yield* fs.makeDirectory(to, { recursive: true });
    for (const entry of yield* fs.readDirectory(from)) {
      const source = pathe.join(from, entry);
      const target = pathe.join(to, entry);
      if ((yield* fs.stat(source)).type === "Directory") {
        yield* overlay(source, target);
      } else {
        yield* fs.writeFile(target, yield* fs.readFile(source));
      }
    }
  });

/**
 * A private clone of the Effect UI fixture for one rendering mode: the
 * hybrid app, with the mode's checked-in overlay
 * (`effect-ui-fixture/modes/<mode>`) copied over it, then `overlay` (a
 * directory of a suite's own files) if given.
 */
export const effectUIFixture = (mode: EffectUIMode, options: { readonly overlay?: string } = {}) =>
  Effect.gen(function* () {
    const root = yield* cloneFixture(fixtureDir, {
      prefix: `effect-ui-${mode}-`,
      tempRoot: pathe.resolve(import.meta.dirname, "../../.tmp"),
      entries: ["index.html", "package.json", "vite.config.ts", "public", "src"],
    });
    yield* overlay(pathe.join(fixtureDir, "modes", mode), root);
    if (options.overlay !== undefined) yield* overlay(options.overlay, root);
    return root;
  });

class RequestFailed extends Data.TaggedError("RequestFailed")<{ url: string; cause: unknown }> {}
class EdgePlaceholder extends Data.TaggedError("EdgePlaceholder")<{ url: string }> {}
class NotServing extends Data.TaggedError("NotServing")<{ url: string; status: number }> {}

const requestOnce = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
      return {
        status: response.status,
        body: await response.text(),
        type: response.headers.get("content-type"),
      };
    },
    catch: (cause) => new RequestFailed({ url, cause }),
  });

/**
 * A fresh deployment can briefly answer from an edge node that has not
 * picked it up yet, with the CDN's own HTML error page (Cloudflare's
 * workers.dev placeholder). The app's own 404 pages are rendered by Effect
 * UI, so retry only the CDN's page.
 */
const request = (url: string, init?: RequestInit) =>
  requestOnce(url, init).pipe(
    Effect.flatMap((result) =>
      result.status >= 400 && result.body.includes("<!--[if lt IE 7]>")
        ? Effect.fail(new EdgePlaceholder({ url }))
        : Effect.succeed(result),
    ),
    Effect.retry({
      while: (error) => error._tag === "EdgePlaceholder",
      schedule: Schedule.spaced("1 second"),
      times: 15,
    }),
  );

/** Each route, and the count a page shows: the query's when rendered on request. */
const routes = (mode: EffectUIMode) => [
  { path: "/?count=7", page: "Home", count: mode === "ssr" ? 7 : 0 },
  { path: "/about?count=9", page: "About", count: mode === "ssr" ? 9 : 0 },
  ...(mode === "ssg" ? [] : [{ path: "/counter/42?count=3", page: "Counter", count: 3 }]),
];

const rendered = (body: string, page: string, count: number) =>
  body.includes(`id="page">${page}<`) && body.includes(`id="count">${count}<`);

/**
 * Exercise the public origin: assets, prerendered pages, and the deployed
 * server handler. `runtime` matches the server's `navigator.userAgent`
 * (`/Cloudflare-Workers/`, `/Node\.js/`), which proves where pages render.
 */
export const verifyEffectUIRendering = (
  origin: string,
  mode: EffectUIMode,
  options: { readonly runtime?: RegExp } = {},
) =>
  Effect.gen(function* () {
    const base = origin.replace(/\/+$/, "");
    // Readiness: the asset layer and the server can go live at different
    // moments, so wait for both an asset and the first page.
    const ready = (path: string, check: (body: string) => boolean) =>
      request(base + path).pipe(
        Effect.flatMap((result) =>
          result.status === 200 && check(result.body)
            ? Effect.void
            : Effect.fail(new NotServing({ url: base + path, status: result.status })),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
      );
    yield* ready("/effect-ui-probe.txt", (body) => body === "EFFECT_UI_STATIC_ASSET");
    const first = routes(mode)[0]!;
    yield* ready(first.path, (body) =>
      mode === "spa" ? body.includes('id="app"') : rendered(body, first.page, first.count),
    );
    const assetHead = yield* request(`${base}/effect-ui-probe.txt`, { method: "HEAD" });
    expect(assetHead.status).toBe(200);
    expect(assetHead.body).toBe("");

    for (const route of routes(mode)) {
      const response = yield* request(base + route.path);
      expect({ path: route.path, status: response.status }).toEqual({
        path: route.path,
        status: 200,
      });
      if (mode === "spa") {
        // The shell, which the browser mounts the app into.
        expect(response.body).toContain('<div id="app"><!--app-html--></div>');
        expect(response.body).not.toContain('id="state"');
      } else {
        expect({
          path: route.path,
          rendered: rendered(response.body, route.page, route.count),
        }).toEqual({ path: route.path, rendered: true });
        // The state the browser hydrates from.
        expect(response.body).toContain('<script type="application/json" id="state">');
        expect(response.body).not.toContain("<!--app-html-->");
      }
      const script = response.body.match(/<script[^>]+src="([^" ]+)"/);
      expect(script).not.toBeNull();
      const javascript = yield* request(new URL(script![1]!, base + route.path).href);
      expect(javascript.status).toBe(200);
      expect(javascript.type).toMatch(/javascript/);
      const stylesheet = response.body.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/);
      expect(stylesheet).not.toBeNull();
      const css = yield* request(new URL(stylesheet![1]!, base + route.path).href);
      expect(css.status).toBe(200);
      expect(css.type).toMatch(/text\/css/);
      const head = yield* request(base + route.path, { method: "HEAD" });
      expect({ head: route.path, status: head.status }).toEqual({ head: route.path, status: 200 });
      expect(head.body).toBe("");
    }

    if (mode === "spa") {
      // Deep links get the shell; the browser's router renders the page.
      const deepLink = yield* request(`${base}/not-a-page`);
      expect(deepLink.status).toBe(200);
      expect(deepLink.body).toContain('<div id="app"><!--app-html--></div>');
    } else {
      // The app's own not-found page: rendered on request, or prerendered.
      const notFound = yield* request(`${base}/not-a-page`);
      expect(notFound.status).toBe(404);
      expect(notFound.body).toContain('id="page">NotFound<');
      expect((yield* request(`${base}/assets/missing.js`)).status).toBe(404);
    }
    if ((mode === "ssr" || mode === "hybrid") && options.runtime !== undefined) {
      const runtime = yield* request(`${base}/__runtime`);
      expect(runtime.status).toBe(200);
      expect(runtime.body).toMatch(options.runtime);
    }
    if (mode === "ssg") {
      // No server: a page that wasn't prerendered is not found.
      expect((yield* request(`${base}/counter/42`)).status).toBe(404);
    }
  });

/**
 * The hybrid fixture under `alchemy dev`: `HtmlServerVite` renders every
 * page in the project's Vite dev server, prerendered ones included, so each
 * page shows the query's count.
 */
export const verifyEffectUIDev = (url: string) =>
  Effect.gen(function* () {
    const base = url.replace(/\/+$/, "");
    yield* expectUrlContains(`${base}/about?count=7`, 'id="count">7<', {
      timeout: "120 seconds",
      label: "dev render of a prerendered page",
    });
    yield* expectUrlContains(`${base}/counter/42?count=3`, 'id="count">3<', {
      label: "dev render of a deep link",
    });
    yield* expectDirectStatus(`${base}/not-a-page`, 404, { label: "dev not found" });
  });
