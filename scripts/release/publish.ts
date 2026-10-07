// Publishes the release tarballs to npm under the default `latest` dist-tag,
// authenticating through the job's OIDC token (npm trusted publishing).
//
// Versions already on npm are skipped, so a release that failed part-way can
// be re-run. Every tarball is attempted; the command fails afterwards if any
// publish failed. Results are logged and, in GitHub Actions, written to the
// job summary.
//
// Usage: node scripts/release/publish.ts [--dir release-packages]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

type Outcome = "published" | "skipped" | "failed";

interface Result {
  readonly spec: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

/** Runs a command, returning its exit code and captured stdout. */
const run = Effect.fn(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly inherit?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          stdout: options.inherit ? "inherit" : "pipe",
          stderr: options.inherit ? "inherit" : "ignore",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          options.inherit
            ? Effect.succeed("")
            : handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout: stdout.trim() };
    }),
  );
});

/** `name@version` from the tarball's `package/package.json`. */
const specOf = Effect.fn(function* (tarball: string) {
  const { exitCode, stdout } = yield* run("tar", ["-xOzf", tarball, "package/package.json"]);
  if (exitCode !== 0) {
    return yield* Effect.fail(new Error(`${tarball}: cannot read package/package.json`));
  }
  const { name, version } = JSON.parse(stdout) as { name: string; version: string };
  return `${name}@${version}`;
});

const publishOne = Effect.fn(function* (tarball: string) {
  const spec = yield* specOf(tarball);

  const existing = yield* run("pnpm", ["view", spec, "version"]);
  if (existing.exitCode === 0 && existing.stdout !== "") {
    yield* Console.log(`- ${spec}: already on npm, skipped`);
    return { spec, outcome: "skipped", detail: "already on npm" } satisfies Result;
  }

  yield* Console.log(`- ${spec}: publishing`);
  const published = yield* run(
    "pnpm",
    ["publish", tarball, "--access", "public", "--no-git-checks"],
    { inherit: true },
  );
  if (published.exitCode !== 0) {
    yield* Console.error(`- ${spec}: publish failed (exit code ${published.exitCode})`);
    return {
      spec,
      outcome: "failed",
      detail: `exit code ${published.exitCode}`,
    } satisfies Result;
  }
  yield* Console.log(`- ${spec}: published to latest`);
  return { spec, outcome: "published", detail: "latest" } satisfies Result;
});

const summarize = Effect.fn(function* (results: ReadonlyArray<Result>) {
  const fs = yield* FileSystem.FileSystem;
  const count = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
  const totals = `${count("published")} published, ${count("skipped")} skipped, ${count("failed")} failed`;
  yield* Console.log(`\n${totals}`);

  const summaryPath = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"));
  if (Option.isSome(summaryPath)) {
    const icon: Record<Outcome, string> = { published: "✅", skipped: "⏭️", failed: "❌" };
    const rows = results.map(
      (result) =>
        `| \`${result.spec}\` | ${icon[result.outcome]} ${result.outcome} | ${result.detail} |`,
    );
    yield* fs.writeFileString(
      summaryPath.value,
      [
        "### npm publish",
        "",
        totals,
        "",
        "| Package | Result | Detail |",
        "| --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
});

const command = Command.make(
  "publish",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("Directory holding the release tarballs"),
      Flag.withDefault("release-packages"),
    ),
  },
  Effect.fn(function* ({ dir }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const tarballs = (yield* fs.readDirectory(dir))
      .filter((file) => file.endsWith(".tgz"))
      .sort()
      .map((file) => path.join(dir, file));
    if (tarballs.length === 0) {
      return yield* Effect.fail(new Error(`No tarballs in ${dir}`));
    }
    yield* Console.log(`Publishing ${tarballs.length} tarball(s) from ${dir}:`);

    const results = yield* Effect.forEach(tarballs, publishOne);
    yield* summarize(results);

    const failed = results.filter((result) => result.outcome === "failed");
    if (failed.length > 0) {
      return yield* Effect.fail(
        new Error(`Failed to publish: ${failed.map((result) => result.spec).join(", ")}`),
      );
    }
  }),
).pipe(Command.withDescription("Publish the release tarballs to npm under latest"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
