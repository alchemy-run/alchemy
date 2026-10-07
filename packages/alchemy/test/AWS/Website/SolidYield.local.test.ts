import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

describe(
  "AWS.Website.SolidYield local",
  { tags: ["provider:aws", "provider:aws:website", "local"] },
  () => {
    test.provider(
      "dev runs the app's own Vite dev server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-aws-local-");

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* AWS.Website.SolidYield("SolidYieldSite", { rootDir });
              return { site };
            }),
          );

          // The site is Vite's own dev server (the solid-yield plugin runs
          // inside it): a localhost URL and no cloud rows at all — proof no
          // AWS call ran, and specifically NOT a *.cloudfront.net URL.
          const url = deployed.site.url! as string;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/);
          expect(deployed.site.distribution).toBeUndefined();
          expect(deployed.site.server).toBeUndefined();
          expect(deployed.site.bucket).toBeUndefined();
          expect(deployed.site.files).toBeUndefined();

          yield* expectUrlContains(`${url}/`, solidYieldPageMarker, {
            timeout: "120 seconds",
            label: "dev index page",
          });
          // Deep links fall back to index.html in dev too.
          yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
            timeout: "60 seconds",
            headers: { accept: "text/html" },
            label: "dev spa fallback",
          });
          // The component module is served through the app's own plugins:
          // vite-plugin-solid-yield rewrites each JSX hole `{yield* x}` to
          // `perform(x)` before Solid's compiler emits DOM templates.
          const module = yield* expectUrlContains(`${url}/src/app.tsx`, solidYieldAppMarker, {
            timeout: "60 seconds",
            label: "dev module source",
          });
          expect(module).toContain("perform(");
          expect(module).not.toContain("{yield* count}");

          // ── HMR surface: edit index.html in place. The stack is NOT
          // re-applied — Vite's dev server serves the transformed html per
          // request, so the same URL must show the new marker ───────────────
          const indexPath = path.join(rootDir, "index.html");
          const index = yield* fs.readFileString(indexPath);
          yield* fs.writeFileString(
            indexPath,
            index.replaceAll(solidYieldPageMarker, `${solidYieldPageMarker} V2`),
          );
          yield* expectUrlContains(`${url}/`, `${solidYieldPageMarker} V2`, {
            timeout: "90 seconds",
            label: "index page after edit",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  },
);
