import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "waku-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const wakuProps = (rootDir: string) => ({
  rootDir,
  url: true as const,
  subdomain: { enabled: true, previewsEnabled: true },
  // Waku's server runtime needs AsyncLocalStorage.
  compatibility: {
    date: "2026-03-10",
    flags: ["nodejs_als"],
  },
  memo: {
    include: ["src/**", "public/**", "package.json", "tsconfig.json"],
  },
});

test.provider(
  "Waku: deploys RSC SSR + binding + static assets and memoizes unchanged rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-",
        tempRoot,
        entries: [
          ".gitignore",
          "package.json",
          "tsconfig.json",
          "public",
          "src",
        ],
      });

      const bindingMarker = "waku-binding-marker";

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Waku("WakuSite", {
              ...wakuProps(rootDir),
              env: {
                MESSAGE: bindingMarker,
              },
            });
          }),
        );

      const site1 = yield* deploy();

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // Dynamic RSC page rendered by the Worker at request time.
      yield* expectUrlContains(`${site1.url!}/`, "WAKU_PAGE_MARKER", {
        timeout: "120 seconds",
        label: "waku dynamic home page",
      });

      // The same page reads the `MESSAGE` binding from `cloudflare:workers`
      // env at request time — proves bindings reach the RSC server bundle.
      yield* expectUrlContains(`${site1.url!}/`, `MESSAGE=${bindingMarker}`, {
        timeout: "60 seconds",
        label: "waku env binding in SSR output",
      });

      // Static asset from `public/`.
      yield* expectUrlContains(
        `${site1.url!}/hello.txt`,
        "hello from public/",
        {
          timeout: "60 seconds",
          label: "waku static asset",
        },
      );

      // SSG page prerendered at build time and served from assets.
      yield* expectUrlContains(
        `${site1.url!}/about`,
        "WAKU_ABOUT_STATIC_MARKER",
        {
          timeout: "60 seconds",
          label: "waku SSG page",
        },
      );

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without rebuilding ───────────────────────
      const site2 = yield* deploy();

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit a page ⇒ the input hash changes and the new
      // content deploys. The edited marker is asserted on the *dynamic*
      // page (worker-rendered per request) — a changed static asset at the
      // same URL can stay stale at a PoP far longer than a worker-version
      // flip ─────────────────────────────────────────────────────────────
      const indexPath = path.join(rootDir, "src/pages/index.tsx");
      const index = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        index.replace("WAKU_PAGE_MARKER", "WAKU_PAGE_MARKER_V2"),
      );

      const site3 = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "WAKU_PAGE_MARKER_V2", {
        timeout: "180 seconds",
        label: "waku dynamic page after edit",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
