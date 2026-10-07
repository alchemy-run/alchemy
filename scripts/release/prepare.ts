// Picks the release version and stamps it on every publishable package.
//
// The spec selects the version:
// - `beta` (default), `alpha` or `rc`: the next `2.0.0-<channel>.N`. A
//   previous candidate that reached npm for only some packages, or never got
//   its git tag, is retried instead of skipped.
// - `beta.N`, `alpha.N`, `rc.N`: that exact candidate.
// - `x.y.z`, or `patch` / `minor` / `major` of the latest stable on npm.
// - anything else: `0.0.0-<spec>`.
//
// Writes the version into each `packages/*/package.json`, records the
// packages in `release-packages.json`, refreshes the lockfile and validates
// the result. stdout carries only `version=` and `channel=` lines for
// `$GITHUB_OUTPUT`; everything else goes to stderr.
//
// Usage: node scripts/release/prepare.ts [spec]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import { Argument, Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

type Channel = "release" | "beta" | "alpha" | "rc" | "tag";

interface Package {
  readonly dir: string;
  readonly manifest: Record<string, unknown> & { name: string; version: string };
}

/** Runs a command; stdout is captured (and echoed to stderr), stderr inherited. */
const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { cwd, stdout: "pipe", stderr: "inherit" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout: stdout.trim() };
    }),
  );
});

const runOrFail = Effect.fn(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
  const result = yield* run(command, args, cwd);
  if (result.stdout) yield* Console.error(result.stdout);
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(`${command} ${args.join(" ")} exited with code ${result.exitCode}`),
    );
  }
});

/** Every version of `name` on npm (empty when unpublished). */
const npmVersions = Effect.fn(function* (name: string) {
  const response = yield* HttpClient.get(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (response.status !== 200) return [];
  const json = (yield* response.json) as { versions?: Record<string, unknown> };
  return Object.keys(json.versions ?? {});
});

const compare = (a: string, b: string) => {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]!;
};

/** The next `2.0.0-<channel>.N`, retrying an incomplete previous candidate. */
const nextPrerelease = Effect.fn(function* (
  root: string,
  packages: ReadonlyArray<Package>,
  channel: Channel,
) {
  const matcher = new RegExp(`^2\\.0\\.0-${channel}\\.(\\d+)$`);
  const maxima = yield* Effect.forEach(
    packages,
    ({ manifest }) =>
      npmVersions(manifest.name).pipe(
        Effect.map((versions) =>
          Math.max(0, ...versions.map((candidate) => Number(candidate.match(matcher)?.[1] ?? 0))),
        ),
      ),
    { concurrency: "unbounded" },
  );
  const maximum = Math.max(0, ...maxima);
  const tagged =
    maximum > 0 &&
    (yield* run(
      "git",
      ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v2.0.0-${channel}.${maximum}`],
      root,
    )).exitCode === 0;
  const complete = maximum > 0 && maxima.every((value) => value === maximum);
  return `2.0.0-${channel}.${complete && tagged ? maximum + 1 : maximum || 1}`;
});

const resolveVersion = Effect.fn(function* (
  root: string,
  packages: ReadonlyArray<Package>,
  spec: string,
) {
  const prerelease = spec.match(/^(beta|alpha|rc)(?:\.(\d+))?$/);
  if (spec === "" || prerelease) {
    const channel = (prerelease?.[1] ?? "beta") as Channel;
    const explicit = prerelease?.[2];
    const version = explicit
      ? `2.0.0-${channel}.${explicit}`
      : yield* nextPrerelease(root, packages, channel);
    return { channel, version };
  }
  if (/^\d+\.\d+\.\d+$/.test(spec)) return { channel: "release" as Channel, version: spec };
  if (spec === "patch" || spec === "minor" || spec === "major") {
    const stable = (yield* npmVersions(packages[0]!.manifest.name))
      .filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate))
      .sort(compare)
      .at(-1);
    if (!stable) {
      return yield* Effect.fail(
        new Error("Cannot calculate a stable bump without a published stable version"),
      );
    }
    let [major, minor, patch] = stable.split(".").map(Number) as [number, number, number];
    if (spec === "major") [major, minor, patch] = [major + 1, 0, 0];
    if (spec === "minor") [minor, patch] = [minor + 1, 0];
    if (spec === "patch") patch += 1;
    return { channel: "release" as Channel, version: `${major}.${minor}.${patch}` };
  }
  if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(spec)) {
    return yield* Effect.fail(new Error(`Invalid release spec: ${spec}`));
  }
  return { channel: "tag" as Channel, version: `0.0.0-${spec}` };
});

const command = Command.make(
  "prepare",
  {
    spec: Argument.String("spec").pipe(
      Argument.withDescription("Release spec (see the header of this file); defaults to beta"),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ spec }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../..");

    const entries = (yield* fs.readDirectory(path.join(root, "packages"))).sort();
    const packages = (yield* Effect.forEach(entries, (entry) => {
      const manifestPath = path.join(root, "packages", entry, "package.json");
      return fs.exists(manifestPath).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs.readFileString(manifestPath).pipe(
                Effect.map((text) => ({
                  dir: `packages/${entry}`,
                  manifest: JSON.parse(text) as Package["manifest"],
                })),
              )
            : Effect.succeed(undefined),
        ),
      );
    })).filter((pkg): pkg is Package => pkg !== undefined && pkg.manifest.private !== true);

    const { channel, version } = yield* resolveVersion(
      root,
      packages,
      Option.getOrElse(spec, () => "").trim(),
    );
    yield* Console.error(`Releasing ${packages.length} packages at ${version} (${channel})`);

    yield* Effect.forEach(packages, (pkg) =>
      fs.writeFileString(
        path.join(root, pkg.dir, "package.json"),
        `${JSON.stringify({ ...pkg.manifest, version }, null, 2)}\n`,
      ),
    );
    yield* fs.writeFileString(
      path.join(root, "release-packages.json"),
      `${JSON.stringify(
        packages.map(({ dir, manifest }) => ({ dir, name: manifest.name })),
        null,
        2,
      )}\n`,
    );

    yield* runOrFail("pnpm", ["install", "--lockfile-only"], root);
    yield* runOrFail("node", ["scripts/validate-publish-packages.ts"], root);

    yield* Console.log(`version=${version}`);
    yield* Console.log(`channel=${channel}`);
  }),
).pipe(Command.withDescription("Pick the release version and stamp it on every package"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  // Report failures on stderr: stdout is reserved for `$GITHUB_OUTPUT`.
  Effect.catchCause((cause) =>
    Console.error(Cause.pretty(cause)).pipe(
      Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
    ),
  ),
  NodeRuntime.runMain,
);
