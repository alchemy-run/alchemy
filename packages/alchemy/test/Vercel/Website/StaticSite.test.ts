/**
 * Vercel.Website.StaticSite lifecycle tests — live against the standing
 * Vercel test team (run with the doppler alchemy-v2/dev env).
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

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
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

/** Poll (bounded) until the URL serves a body containing `marker`. */
const expectUrlContains = (url: string, marker: string) =>
  Effect.gen(function* () {
    const text = yield* getText(url).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (t) => t.includes(marker),
        times: 20,
      }),
    );
    expect(text).toContain(marker);
  });

/** Poll (bounded) until the site's project is gone. */
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

const htmlPage = (marker: string) =>
  `<!doctype html>\n<html><body><h1>${marker}</h1></body></html>\n`;

test.provider(
  "static site: deploy, serve, no-op redeploy, content change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Fixture generated in a temp dir: index.html + a cp build script.
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-vercel-static-",
      });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(fs.remove(dir, { recursive: true })),
      );
      yield* fs.makeDirectory(path.join(dir, "src"), { recursive: true });
      // dist is build output — keep it out of the memo input hash.
      yield* fs.writeFileString(path.join(dir, ".gitignore"), "dist\n");
      const buildSh = path.join(dir, "build.sh");
      yield* fs.writeFileString(
        buildSh,
        "#!/bin/sh\nmkdir -p dist\ncp src/index.html dist/index.html\n",
      );
      yield* fs.chmod(buildSh, 0o755);
      yield* fs.writeFileString(
        path.join(dir, "src", "index.html"),
        htmlPage("static-marker-v1"),
      );

      const makeSite = () =>
        Effect.gen(function* () {
          return yield* Vercel.Website.StaticSite("Site", {
            command: "./build.sh",
            cwd: dir,
            outdir: "dist",
          });
        });

      // 1. Greenfield deploy — served over the production alias.
      const site1 = yield* stack.deploy(makeSite());
      expect(site1.projectId).toBeDefined();
      expect(site1.deploymentId).not.toEqual("");
      expect(site1.url).toBeDefined();
      yield* expectUrlContains(`${site1.url}/index.html`, "static-marker-v1");

      // 2. Redeploy with unchanged content: build memo + skip-on-hash keep
      //    the deployment (no new immutable deployment is minted).
      const site2 = yield* stack.deploy(makeSite());
      expect(site2.projectId).toEqual(site1.projectId);
      expect(site2.deploymentId).toEqual(site1.deploymentId);

      // 3. Content change rebuilds and redeploys — the production alias
      //    serves the new content and the old marker is fully replaced.
      yield* fs.writeFileString(
        path.join(dir, "src", "index.html"),
        htmlPage("static-marker-v2"),
      );
      const site3 = yield* stack.deploy(makeSite());
      expect(site3.projectId).toEqual(site1.projectId);
      expect(site3.deploymentId).not.toEqual(site1.deploymentId);
      yield* expectUrlContains(`${site3.url}/index.html`, "static-marker-v2");

      // 4. Destroy cascades the owned project; typed wait-until-gone.
      yield* stack.destroy();
      yield* expectProjectGone(site1.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
