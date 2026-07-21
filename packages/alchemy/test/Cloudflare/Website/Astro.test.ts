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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/astro-app");

// Keep the temp clone under the alchemy package so the project root stays
// within the workspace (same constraint as the Vite tests) and so the
// fixture's `astro` dependency resolves by walking up to
// `packages/alchemy/node_modules`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "Astro: SSR + env binding + prerender + static assets deploy; unchanged sources memo-skip the rebuild",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-astro-",
        tempRoot,
        entries: ["package.json", "public", "src"],
      });

      // Restrict the input memo to fixture sources so the test isn't
      // re-hashing the whole monorepo on every deploy.
      const memoInclude = ["src/**", "public/**", "package.json"];

      // A random value is fine here — it is binding data, not a resource
      // name — and it stays constant across this test's deploys so the
      // metadata hash cannot mask a broken input-hash memo.
      const marker = `astro-marker-${Date.now()}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Astro("AstroSite", {
              rootDir,
              url: true,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: {
                date: "2026-03-10",
                flags: ["nodejs_compat"],
              },
              memo: { include: memoInclude },
              env: { TEST_MARKER: marker },
              assets: {
                htmlHandling: "auto-trailing-slash",
                notFoundHandling: "none",
              },
            });
          }),
        );

      // ── deploy 1: build + serve ────────────────────────────────────────
      const site1 = yield* deploy();
      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // SSR page rendered in the Worker, reading the env binding.
      yield* expectUrlContains(`${site1.url!}/`, marker, {
        timeout: "120 seconds",
        label: "SSR page renders env binding",
      });
      // Prerendered page served from static assets.
      yield* expectUrlContains(`${site1.url!}/about/`, "prerendered-page", {
        timeout: "60 seconds",
        label: "prerendered page",
      });
      // Plain static asset from public/.
      yield* expectUrlContains(
        `${site1.url!}/static.txt`,
        "astro-static-asset",
        {
          timeout: "60 seconds",
          label: "static asset",
        },
      );

      // ── deploy 2: nothing changed ⇒ memo hit (no rebuild) ──────────────
      const site2 = yield* deploy();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.hash?.bundle).toEqual(site1.hash?.bundle);
      expect(site2.hash?.assets).toEqual(site1.hash?.assets);

      // ── deploy 3: edit a page ⇒ memo busts, new content serves ─────────
      const indexPath = path.join(rootDir, "src/pages/index.astro");
      const source = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        source.replace("Astro Fixture", "Astro Fixture Edited"),
      );

      const site3 = yield* deploy();
      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "Astro Fixture Edited", {
        timeout: "60 seconds",
        label: "edited SSR page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);
