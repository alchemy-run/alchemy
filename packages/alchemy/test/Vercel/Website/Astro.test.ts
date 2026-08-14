/**
 * Vercel.Website.Astro lifecycle test.
 *
 * LIVE-VERIFIED (2026-08-13: install + build + deploy + serve + destroy
 * green) but GATED behind VERCEL_TEST_FRAMEWORKS=1: the `@astrojs/vercel`
 * adapter is not vendored in this repository (only `astro` itself is
 * hoisted), so the fixture installs its own dependencies at build time
 * (`bun install`, network access required). Ungated CI would be slow and
 * flaky on registry weather — run explicitly with:
 *
 *     VERCEL_TEST_FRAMEWORKS=1 doppler run --project alchemy-v2 --config dev -- \
 *       bun run test test/Vercel/Website/Astro.test.ts
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

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

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

/** Minimal Astro project with the Vercel adapter (installed at build). */
const writeFixture = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "src", "pages"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "alchemy-vercel-astro-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@astrojs/vercel": "^8",
          astro: "^5",
        },
      },
      null,
      2,
    ),
  );
  yield* fs.writeFileString(
    path.join(dir, "astro.config.mjs"),
    [
      `import vercel from "@astrojs/vercel";`,
      `export default { output: "server", adapter: vercel() };`,
      ``,
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(dir, "src", "pages", "index.astro"),
    "<html><body><h1>astro-vercel-marker</h1></body></html>\n",
  );
  yield* fs.writeFileString(
    path.join(dir, ".gitignore"),
    "dist\n.astro\n.vercel\nnode_modules\n",
  );
  // `&&` needs a shell — ship the install+build as an executable script.
  const buildSh = path.join(dir, "build.sh");
  yield* fs.writeFileString(
    buildSh,
    "#!/bin/sh\nset -e\nbun install\nbunx astro build\n",
  );
  yield* fs.chmod(buildSh, 0o755);
});

test.provider.skipIf(!process.env.VERCEL_TEST_FRAMEWORKS)(
  "astro site: adapter build, deploy, drive, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-vercel-astro-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(fs.remove(dir, { recursive: true })),
      );
      yield* writeFixture(dir);

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Website.Astro("Site", {
            rootDir: dir,
            command: "./build.sh",
          });
        }),
      );
      expect(site.url).toBeDefined();

      const page = yield* getText(`${site.url}/`);
      expect(page).toContain("astro-vercel-marker");

      yield* stack.destroy();
      yield* expectProjectGone(site.projectId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
