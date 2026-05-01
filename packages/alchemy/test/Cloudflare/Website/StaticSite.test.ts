import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "staticsite-fixture");
const workerEntry = pathe.resolve(import.meta.dirname, "../Workers/worker.ts");

test.provider(
  "StaticSite: editing a source file republishes the assets in a single deploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-fix-",
        entries: ["src", "build.sh"],
      });
      const indexPath = path.join(cwd, "src", "index.html");

      // ── deploy 1: initial publish ──────────────────────────────────────
      const v1Marker = `staticsite-v1-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", staticSiteProps(cwd));
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.assets).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);
      // End-to-end: the worker URL actually serves the v1 marker.
      // Use a long timeout because workers.dev subdomains can take 60s+
      // to propagate the very first time they're enabled.
      yield* expectUrlContains(`${site1.url!}/index.html`, v1Marker, {
        timeout: "120 seconds",
        label: "deploy1 v1 marker",
      });

      // ── deploy 2: edit fixture, redeploy once ──────────────────────────
      const v2Marker = `staticsite-v2-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v2Marker));

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", staticSiteProps(cwd));
        }),
      );

      expect(site2.hash?.assets).toBeDefined();
      expect(site2.hash?.assets).not.toEqual(site1.hash?.assets);

      // The single-deploy guarantee: after one redeploy, the new
      // marker is reachable over HTTP. Before the fix, this failure
      // mode is what users were hitting — the worker version finalized
      // pointing at the previous asset manifest because the initial
      // Worker.update read dist mid-write.
      yield* expectUrlContains(`${site2.url!}/index.html`, v2Marker, {
        timeout: "60 seconds",
        label: "deploy2 v2 marker",
      });
      // And the v1 marker should be gone — i.e. the new deploy fully
      // replaced the previous content rather than coexisting with it.
      yield* expectUrlAbsent(`${site2.url!}/index.html`, v1Marker, {
        timeout: "30 seconds",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

const staticSiteProps = (cwd: string) => ({
  command: "bash build.sh",
  cwd,
  outdir: "dist",
  main: workerEntry,
  url: true as const,
  subdomain: { enabled: true, previewsEnabled: true },
  compatibility: { date: "2024-01-01" },
});

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

/**
 * Inverse of `expectUrlContains`: succeeds if the marker is *absent*
 * from the response within the timeout. We drive this off the same
 * primitive by inverting the check at the call site.
 */
const expectUrlAbsent = (
  url: string,
  marker: string,
  options: { timeout?: Duration.Input },
) =>
  Effect.gen(function* () {
    yield* expectUrlContains(url, "<", { ...options, label: "page exists" });
    const u = new URL(url);
    u.searchParams.set("__alchemy_cb", String(Date.now()));
    const body = yield* Effect.promise(() =>
      fetch(u, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      }).then((r) => r.text()),
    );
    expect(
      body.includes(marker),
      `expected URL ${url} to NOT contain "${marker}", but it did`,
    ).toBe(false);
  });
