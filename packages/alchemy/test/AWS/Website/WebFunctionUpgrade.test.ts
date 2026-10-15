import { spawn } from "node:child_process";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
/**
 * Cross-version upgrade test for moving AWS framework sites onto Lambda Web
 * Functions.
 *
 * A temp project deploys a Nuxt site with the PUBLISHED alchemy and
 * frontend-frameworks 2.0.0-beta.81 (SSR on a Lambda Function URL), then the
 * CURRENT workspace version re-deploys over the same local state. The site
 * must move onto a Web Function and keep its CloudFront distribution, and
 * the old function must be deleted.
 */
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

const PUBLISHED = "2.0.0-beta.81";
const STACK = "WebFunctionUpgradeTest";
const STAGE = "wfupgrade";

const repoRoot = pathe.resolve(import.meta.dirname, "../../../../..");
const workspaceCli = pathe.join(repoRoot, "packages/alchemy/bin/alchemy.js");
const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");
// Under the alchemy package so `nuxt` resolves from the workspace's
// node_modules; `alchemy` and `@alchemy.run/frontend-frameworks` resolve
// from the temp project's own node_modules first.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/**
 * Run a command to completion without blocking the runner's event loop.
 * Fails with the combined output on a non-zero exit.
 */
const run = (options: { cmd: string; args: string[]; cwd: string }) =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      // `CI=1` keeps both CLIs non-interactive; AWS credentials come from
      // the environment, which every version reads.
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new Error(`${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

/** The stack program, valid for both versions. */
const stackProgram = (alchemyImport: string, awsImport: string) =>
  [
    `import * as Alchemy from "${alchemyImport}";`,
    `import * as AWS from "${awsImport}";`,
    "",
    "export default Alchemy.Stack(",
    `  "${STACK}",`,
    "  { providers: AWS.providers(), state: Alchemy.localState() },",
    '  AWS.Website.Nuxt("Site", {',
    "    forceDestroy: true,",
    '    invalidation: { paths: "all", wait: true },',
    "  }),",
    ");",
    "",
  ].join("\n");

test.provider.skipIf(!!process.env.FAST)(
  `a Nuxt site deployed by ${PUBLISHED} moves onto a Web Function and keeps its distribution`,
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-wf-upgrade-",
        tempRoot,
        entries: [".gitignore", "nuxt.config.ts", "app", "server", "public"],
      });
      const stateFile = (fqn: string) =>
        // LocalState layout: .alchemy/state/<stack>/<stage>/<encodeFqn>.json
        path.join(dir, ".alchemy", "state", STACK, STAGE, `${fqn}.json`);
      const readRow = (fqn: string) =>
        fs.readFileString(stateFile(fqn)).pipe(Effect.map((raw) => JSON.parse(raw)));

      // Destroy whatever this attempt deployed even when a step fails. The
      // published CLI is the fallback for a state the current version
      // cannot load.
      const destroy = run({
        cmd: "bun",
        args: [workspaceCli, "destroy", "./alchemy.current.run.ts", "--stage", STAGE, "--yes"],
        cwd: dir,
      }).pipe(
        Effect.catch(() =>
          run({
            cmd: "bun",
            args: ["node_modules/alchemy/bin/cli.js", "destroy", "--stage", STAGE, "--yes"],
            cwd: dir,
          }),
        ),
      );
      const cleanup = destroy.pipe(
        Effect.ignore,
        Effect.andThen(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
      );

      yield* Effect.gen(function* () {
        // ── Fixture ─────────────────────────────────────────────────────────
        yield* fs.writeFileString(
          path.join(dir, "package.json"),
          JSON.stringify(
            {
              name: "web-function-upgrade-fixture",
              private: true,
              type: "module",
              dependencies: {
                alchemy: PUBLISHED,
                "@alchemy.run/frontend-frameworks": PUBLISHED,
              },
            },
            null,
            2,
          ),
        );
        yield* fs.writeFileString(
          path.join(dir, "alchemy.run.ts"),
          stackProgram("alchemy", "alchemy/AWS"),
        );
        // Current-version entry: the WORKSPACE sources by absolute path.
        yield* fs.writeFileString(
          path.join(dir, "alchemy.current.run.ts"),
          stackProgram(
            pathe.join(repoRoot, "packages/alchemy/src/index.ts"),
            pathe.join(repoRoot, "packages/alchemy/src/AWS/index.ts"),
          ),
        );

        // ── Phase 1: deploy with the published version ──────────────────────
        // Peers (nuxt, astro, ...) resolve from the workspace above.
        yield* run({ cmd: "bun", args: ["install", "--omit", "peer"], cwd: dir });
        yield* run({
          cmd: "bun",
          args: ["node_modules/alchemy/bin/cli.js", "deploy", "--stage", STAGE, "--yes"],
          cwd: dir,
        });

        const oldServer = yield* readRow("Site__Server");
        expect(oldServer.attr.functionUrl).toContain(".lambda-url.");
        const before = yield* readRow("Site__Distribution");
        const distributionId: string = before.attr.distributionId;
        const siteUrl = `https://${before.attr.domainName}`;
        yield* expectUrlContains(`${siteUrl}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR page from the published version",
        });

        // ── Phase 2: re-deploy with the CURRENT workspace version ───────────
        // The upgrade a user runs bumps both packages together.
        const linked = path.join(dir, "node_modules", "@alchemy.run", "frontend-frameworks");
        yield* fs.remove(linked, { recursive: true });
        yield* fs.symlink(path.join(repoRoot, "packages/frontend-frameworks"), linked);
        yield* run({
          cmd: "bun",
          args: [workspaceCli, "deploy", "./alchemy.current.run.ts", "--stage", STAGE, "--yes"],
          cwd: dir,
        });

        // The server moved onto a Web Function and the old function is gone.
        const webServer = yield* readRow("Site__WebServer");
        expect(webServer.attr.domainName).toContain(".lambda-web.");
        expect(yield* fs.exists(stateFile("Site__Server"))).toBe(false);

        // THE assertion: same distribution, same URL, still serving.
        const after = yield* readRow("Site__Distribution");
        expect(after.attr.distributionId).toEqual(distributionId);
        yield* expectUrlContains(`${siteUrl}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR page after the upgrade",
        });

        // ── Cleanup ─────────────────────────────────────────────────────────
        yield* destroy;
        yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
          Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
          Effect.catchTag("NoSuchDistribution", () => Effect.void),
          Effect.retry({
            while: (error) => error instanceof Error && error.message === "DistributionStillExists",
            schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
          }),
        );
      }).pipe(Effect.ensuring(cleanup));
    }),
  {
    tags: ["provider:aws", "provider:aws:cloudfront", "provider:aws:website", "live"],
    timeout: 2_400_000,
  },
);
