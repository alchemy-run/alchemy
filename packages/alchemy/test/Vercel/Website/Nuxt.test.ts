/**
 * Vercel.Website.Nuxt lifecycle test — live against the standing Vercel
 * test team (run with the doppler alchemy-v2/dev env).
 *
 * The fixture is generated into `packages/alchemy/.tmp` so `nuxi`/`nuxt`
 * resolve from the workspace's hoisted node_modules (the same convention
 * as the Cloudflare Nuxt tests). Nitro's `vercel` preset is built in — no
 * adapter package is needed.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Keep the temp fixture under the alchemy package so `nuxt`/`nitropack`
// resolve from the workspace's hoisted node_modules.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

/** Write the minimal Nuxt fixture (one page + one server route). */
const writeFixture = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "app"), { recursive: true });
  yield* fs.makeDirectory(path.join(dir, "server", "api"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "alchemy-vercel-nuxt-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  yield* fs.writeFileString(
    path.join(dir, "nuxt.config.ts"),
    [
      `import { defineNuxtConfig } from "nuxt/config";`,
      `export default defineNuxtConfig({`,
      `  compatibilityDate: "2026-07-01",`,
      `  telemetry: { enabled: false },`,
      `});`,
      ``,
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(dir, "app", "app.vue"),
    "<template>\n  <div>vercel-nuxt-marker</div>\n</template>\n",
  );
  yield* fs.writeFileString(
    path.join(dir, "server", "api", "hello.ts"),
    `export default defineEventHandler(() => ({ ok: true, from: "nitro" }));\n`,
  );
  // Build output must stay out of the memo input hash.
  yield* fs.writeFileString(
    path.join(dir, ".gitignore"),
    ".nuxt\n.output\n.vercel\nnode_modules\n",
  );
});

test.provider(
  "nuxt site: build via nitro vercel preset, deploy, drive SSR + API, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(tempRoot, { recursive: true });
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-vercel-nuxt-",
        directory: tempRoot,
      });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(fs.remove(dir, { recursive: true })),
      );
      yield* writeFixture(dir);

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Website.Nuxt("Site", { rootDir: dir });
        }),
      );
      expect(site.projectId).toBeDefined();
      expect(site.deploymentId).not.toEqual("");
      expect(site.url).toBeDefined();

      // SSR page renders the fixture marker over the production alias.
      const page = yield* getText(`${site.url}/`);
      expect(page).toContain("vercel-nuxt-marker");

      // Nitro server route runs as a serverless function.
      const api = yield* getText(`${site.url}/api/hello`);
      expect(JSON.parse(api)).toEqual({ ok: true, from: "nitro" });

      yield* stack.destroy();
      yield* expectProjectGone(site.projectId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
